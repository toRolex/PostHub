"""manifest 批量导入解析服务（ADR-0002 权威）。

批次 = 一个账号下的若干视频；`manifest.json` 顶层 `{"version": 1, "videos": [...]}`。
本模块是批量导入的解析 + 校验 seam（控制者预确认）：

- `parse_manifest(folder_path, platform, now=None) -> ManifestResult`
  解析 manifest.json 并按 ADR-0002 校验表分级：
  - **hard_errors（整批拒绝）**：JSON 语法 / version 不支持 / `file` 缺失或不存在
    或同批重复 / title 超平台上限（抖音 30 / 小红书 20）/ 封面路径不存在 /
    `schedule` 格式非法或超出 2h–7 天区间
  - **warnings（软提示进待确认，黄色标注）**：title 为空（文件名兜底）/
    小红书 tags 超 10 个
- `confirm_import(entries, *, account_id, task_store, accounts) -> [task_ids]`
  待确认列表核对（逐条可覆盖标题/正文/封面/定时/账号/平台）后，逐条走
  `create_task`（与发布页同一发布通道）落库，进入 #17 调度器执行。

账号在导入 UI 选定（manifest 不含账号/平台字段，ADR-0002）；一个批次绑定一个
账号，多账号 = 多次导入。本模块不建 batch 记录，批次与账号的关联通过生成任务的
`platform_job.account_id` 落地（ADR-0002 冲突标注的落地方式二）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

from posthub.accounts import AccountStore
from posthub.constraints import DAY, HOUR, validate_schedule
from posthub.state import TIME_FMT
from posthub.tasks import (
    AccountPlatformMismatchError,
    NewTaskSpec,
    PlatformJobSpec,
    TaskStore,
    TaskValidationError,
    UnknownAccountError,
)

Platform = Literal["douyin", "xiaohongshu", "wechat"]

MANIFEST_VERSION = 1

# ADR-0002 schedule 校验区间：≥2h 且 ≤7 天（超 7 天提示改立即发布，不足 2h 报错）。
MIN_SCHEDULE_LEAD_SECONDS = 2 * HOUR
MAX_SCHEDULE_LEAD_SECONDS = 7 * DAY

# title 超平台上限（ADR-0002 校验表）：抖音 30 / 小红书 20。视频号未限定。
TITLE_MAX_LENGTHS: dict[str, int] = {
    "douyin": 30,
    "xiaohongshu": 20,
}

# 小红书 tags 超 10 个软提示（平台会截断）。
TAGS_SOFT_WARNING_MAX = 10

__all__ = [
    "MANIFEST_VERSION",
    "ManifestIssue",
    "ManifestEntry",
    "ManifestResult",
    "ConfirmEntry",
    "parse_manifest",
    "confirm_import",
]


@dataclass(frozen=True)
class ManifestIssue:
    """单条问题。`index=None` 表示顶层/整批问题（JSON 语法、version 等）。"""

    index: int | None
    message: str

    def to_dict(self) -> dict:
        return {"index": self.index, "message": self.message}


@dataclass(frozen=True)
class ManifestEntry:
    """一条待确认的视频条目（已解析/兜底，路径为绝对路径）。"""

    index: int
    file: str
    title: str
    content: str | None
    tags: list[str]
    cover_landscape: str | None
    cover_portrait: str | None
    schedule: str | None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "file": self.file,
            "title": self.title,
            "content": self.content,
            "tags": self.tags,
            "cover_landscape": self.cover_landscape,
            "cover_portrait": self.cover_portrait,
            "schedule": self.schedule,
            "warnings": self.warnings,
        }


@dataclass(frozen=True)
class ManifestResult:
    """解析结果：`hard_errors` 非空 = 整批拒绝；否则 `entries` 进待确认列表。"""

    version: int
    entries: list[ManifestEntry]
    hard_errors: list[ManifestIssue]

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "entries": [e.to_dict() for e in self.entries],
            "hard_errors": [i.to_dict() for i in self.hard_errors],
        }


@dataclass(frozen=True)
class ConfirmEntry:
    """确认放行的条目（逐条可覆盖标题/正文/封面/定时/账号/平台）。

    `account_id` / `platform` 可空：空则用批次默认账号（及其所属平台）。
    """

    file: str
    title: str
    content: str | None = None
    tags: list[str] | None = None
    cover_landscape: str | None = None
    cover_portrait: str | None = None
    schedule: str | None = None
    account_id: int | None = None
    platform: str | None = None


def _is_valid_time(value: str) -> bool:
    try:
        datetime.strptime(value, TIME_FMT)
        return True
    except ValueError:
        return False


def _resolve_cover(folder: Path, value) -> tuple[str | None, str | None]:
    """解析封面相对路径为绝对路径；空 = 无封面（None, None）；不存在 → 错误消息。"""
    if value is None or value == "":
        return None, None
    if not isinstance(value, str) or not value.strip():
        return None, f"cover 路径必须是字符串：{value!r}"
    rel = value.strip()
    p = (folder / rel).resolve()
    if not p.is_file():
        return None, f"封面文件不存在：{rel}"
    return str(p), None


def parse_manifest(
    folder_path: str | Path,
    platform: str,
    *,
    now: str | None = None,
) -> ManifestResult:
    """解析批次文件夹中的 manifest.json 并逐条校验（ADR-0002 分级）。

    `platform` 来自导入 UI 选定的目标账号（决定 title 上限 / tags 软提示）。
    `now` 可注入便于测试（默认取当前本地时间）。
    """
    folder = Path(folder_path)
    manifest_path = folder / "manifest.json"

    if not manifest_path.is_file():
        return ManifestResult(
            version=MANIFEST_VERSION,
            entries=[],
            hard_errors=[
                ManifestIssue(None, f"文件夹中没有 manifest.json：{folder_path}")
            ],
        )

    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return ManifestResult(
            version=MANIFEST_VERSION,
            entries=[],
            hard_errors=[ManifestIssue(None, f"manifest.json 不是合法 JSON：{exc}")],
        )

    if not isinstance(data, dict):
        return ManifestResult(
            version=MANIFEST_VERSION,
            entries=[],
            hard_errors=[ManifestIssue(None, "manifest.json 顶层必须是 JSON 对象")],
        )

    version = data.get("version")
    if version != MANIFEST_VERSION:
        return ManifestResult(
            version=MANIFEST_VERSION,
            entries=[],
            hard_errors=[
                ManifestIssue(
                    None,
                    f"不支持的 manifest 版本：{version!r}（当前支持 {MANIFEST_VERSION}）",
                )
            ],
        )

    videos = data.get("videos")
    if not isinstance(videos, list):
        return ManifestResult(
            version=MANIFEST_VERSION,
            entries=[],
            hard_errors=[ManifestIssue(None, "manifest.json 缺少 videos 数组")],
        )

    if now is None:
        now = datetime.now().strftime(TIME_FMT)
    now_dt = datetime.strptime(now, TIME_FMT)
    title_max = TITLE_MAX_LENGTHS.get(platform)

    entries: list[ManifestEntry] = []
    hard_errors: list[ManifestIssue] = []
    seen_files: set[str] = set()

    for idx, raw in enumerate(videos):
        entry_hard: list[str] = []
        warnings: list[str] = []

        if not isinstance(raw, dict):
            hard_errors.append(ManifestIssue(idx, f"第 {idx + 1} 条必须是 JSON 对象"))
            continue

        # ---- file：必填，存在，同批唯一 ----
        file_abs: Path | None = None
        file_rel_raw = raw.get("file")
        if file_rel_raw is None or not str(file_rel_raw).strip():
            entry_hard.append("缺少必填字段 file")
        else:
            file_rel = str(file_rel_raw).strip()
            if file_rel in seen_files:
                entry_hard.append(f"同批内文件名重复：{file_rel}")
            file_abs = (folder / file_rel).resolve()
            if not file_abs.is_file():
                entry_hard.append(f"视频文件不存在：{file_rel}")
            else:
                seen_files.add(file_rel)

        # ---- title：可空（文件名兜底）；超平台上限硬报错 ----
        title_raw = raw.get("title")
        title_str = str(title_raw).strip() if title_raw is not None else ""
        if not title_str:
            warnings.append("标题为空，已用文件名兜底")
            title_str = (
                file_abs.stem if file_abs is not None else f"第 {idx + 1} 条"
            )
        if title_max is not None and len(title_str) > title_max:
            entry_hard.append(f"标题超过平台上限（{platform} 最多 {title_max} 字）")

        # ---- content：可选 ----
        content_raw = raw.get("content")
        content_str = str(content_raw).strip() if content_raw is not None else None

        # ---- tags：字符串数组；小红书超 10 软提示 ----
        tags_raw = raw.get("tags") or []
        if not isinstance(tags_raw, list) or not all(
            isinstance(t, str) for t in tags_raw
        ):
            entry_hard.append("tags 必须是字符串数组")
        else:
            if platform == "xiaohongshu" and len(tags_raw) > TAGS_SOFT_WARNING_MAX:
                warnings.append(
                    f"小红书 tags 超过 {TAGS_SOFT_WARNING_MAX} 个（平台会截断）"
                )

        # ---- 封面：可选；路径不存在硬报错 ----
        cover_landscape, cover_err = _resolve_cover(folder, raw.get("cover_landscape"))
        if cover_err:
            entry_hard.append(cover_err)
        cover_portrait, cover_err2 = _resolve_cover(folder, raw.get("cover_portrait"))
        if cover_err2:
            entry_hard.append(cover_err2)

        # ---- schedule：可选；格式 + 2h~7d 区间 ----
        schedule_raw = raw.get("schedule")
        schedule_str: str | None = None
        if schedule_raw is not None and schedule_raw != "":
            if not isinstance(schedule_raw, str) or not schedule_raw.strip():
                entry_hard.append("schedule 必须是字符串")
            else:
                schedule_str = schedule_raw.strip()
                if not _is_valid_time(schedule_str):
                    entry_hard.append(
                        f"schedule 格式必须是 YYYY-MM-DD HH:mm:ss：{schedule_str!r}"
                    )
                else:
                    lead = int(
                        (
                            datetime.strptime(schedule_str, TIME_FMT) - now_dt
                        ).total_seconds()
                    )
                    if lead < MIN_SCHEDULE_LEAD_SECONDS:
                        entry_hard.append("定时时间距现在不足 2 小时")
                    elif lead > MAX_SCHEDULE_LEAD_SECONDS:
                        entry_hard.append("定时时间超过 7 天（可改为立即发布）")

        if entry_hard:
            for msg in entry_hard:
                hard_errors.append(ManifestIssue(idx, f"第 {idx + 1} 条：{msg}"))
            continue

        entries.append(
            ManifestEntry(
                index=idx,
                file=str(file_abs),
                title=title_str,
                content=content_str,
                tags=list(tags_raw),
                cover_landscape=cover_landscape,
                cover_portrait=cover_portrait,
                schedule=schedule_str,
                warnings=warnings,
            )
        )

    return ManifestResult(
        version=MANIFEST_VERSION,
        entries=entries,
        hard_errors=hard_errors,
    )


def _prevalidate_spec(spec: NewTaskSpec, accounts: AccountStore) -> None:
    """预校验单条（与 tasks.create_task 校验一致）。

    全部通过才落库，保证整批确认的原子性：任一条目非法，整批不落库。
    """
    if not spec.title or not spec.title.strip():
        raise TaskValidationError("标题不能为空")
    if spec.schedule_policy == "scheduled" and not spec.publish_at:
        raise TaskValidationError("定时发布必须填写发布时间")
    for jspec in spec.jobs:
        acc = accounts.get(jspec.account_id)
        if acc is None:
            raise UnknownAccountError(f"账号不存在：{jspec.account_id}")
        if acc.platform != jspec.platform:
            raise AccountPlatformMismatchError(
                f"账号 {jspec.account_id} 属于平台 {acc.platform}，"
                f"不能发布到 {jspec.platform}"
            )
        if spec.publish_at:
            errors = validate_schedule(jspec.platform, publish_at=spec.publish_at)
            if errors:
                raise TaskValidationError("；".join(errors))


def confirm_import(
    entries: list[ConfirmEntry],
    *,
    account_id: int,
    task_store: TaskStore,
    accounts: AccountStore,
) -> list[int]:
    """待确认放行：逐条走 `create_task`（与发布页同一发布通道）落库。

    每条可覆盖标题/正文/封面/定时/账号/平台；`account_id` 为批次默认账号。
    返回生成的 task id 列表。任一条目非法则整批不落库（原子）。
    """
    specs: list[NewTaskSpec] = []
    for entry in entries:
        acc_id = entry.account_id if entry.account_id is not None else account_id
        acc = accounts.get(acc_id)
        if acc is None:
            raise UnknownAccountError(f"账号不存在：{acc_id}")
        platform = entry.platform or acc.platform
        spec = NewTaskSpec(
            title=entry.title,
            video_path=entry.file,
            caption=entry.content,
            tags=entry.tags or None,
            cover_horizontal=entry.cover_landscape,
            cover_vertical=entry.cover_portrait,
            schedule_policy="scheduled" if entry.schedule else "immediate",
            publish_mode="platform_time",
            publish_at=entry.schedule,
            jobs=[PlatformJobSpec(platform=platform, account_id=acc_id)],
        )
        _prevalidate_spec(spec, accounts)
        specs.append(spec)

    task_ids: list[int] = []
    for spec in specs:
        task, _ = task_store.create_task(spec)
        task_ids.append(task.id)
    return task_ids
