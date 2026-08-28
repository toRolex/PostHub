"""EffectiveBatchItem 规范化与官方发布执行适配。

本模块是 PostHub-owned 的纯组合层：它只负责把用户提交的官方请求体
校验、拆分账号、冻结账号快照并合并账号默认声明。真正的发布仍由调用方
委托 social-auto-upload 官方函数；这里不实现官方文件/账号遍历、定时或
浏览器执行循环。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any

from posthub.declarations import (
    DeclarationMappingError,
    resolve_platform_fields,
)

_SUPPORTED_PLATFORM_TYPES = {1, 2, 3, 4}
_PLATFORM_NAMES = {
    1: "xiaohongshu",
    2: "wechat",
    3: "douyin",
    4: "kuaishou",
}
_PLATFORM_FIELD_KEYS = {
    "xiaohongshu": {"source", "origin"},
    "wechat": {"declaration", "origin"},
    "douyin": {"declaration"},
}
# 只有确实能在官方执行链路中应用的字段才能进入 effective 命令；
# 没有可靠 DOM/构造参数 seam 时必须拒绝，而不是返回 200 后静默丢字段。
_UNSUPPORTED_EXECUTION_FIELDS = {
    # source 由 PostHub XHS DOM wrapper 执行；origin 仍无可靠 seam，继续 fail-closed。
    "xiaohongshu": {"origin"},
    "wechat": {"origin"},
}


class NormalizationError(ValueError):
    """用户请求无法成为可稳定回放的 EffectiveBatchItem。"""


@dataclass(frozen=True)
class AccountSnapshot:
    """发布前从官方 user_info 拍下的账号值对象。"""

    account_id: int
    platform_type: int
    file_path: str
    user_name: str
    status: int | None
    default_platform_fields: dict[str, dict[str, Any]]

    @property
    def id(self) -> int:
        """兼容官方字段命名。"""
        return self.account_id

    @property
    def filePath(self) -> str:
        """兼容官方 user_info 字段命名。"""
        return self.file_path

    @property
    def type(self) -> int:
        """兼容官方 user_info 字段命名。"""
        return self.platform_type


@dataclass(frozen=True)
class EffectiveBatchItem:
    """一个账号粒度的可回放命令及其用户提交快照。"""

    source_index: int
    platform_type: int
    account_snapshot: AccountSnapshot
    submitted: dict[str, Any]
    effective: dict[str, Any]

    @property
    def platform(self) -> str:
        """PostHub 平台名。"""
        return _PLATFORM_NAMES[self.platform_type]

    @property
    def account(self) -> AccountSnapshot:
        """短名称访问账号快照。"""
        return self.account_snapshot


@dataclass(frozen=True)
class NormalizedPublishBatch:
    """规范化结果，同时保留原始 submitted 与展开后的 effective。"""

    submitted: tuple[dict[str, Any], ...]
    effective: tuple[EffectiveBatchItem, ...]

    @property
    def submitted_payloads(self) -> tuple[dict[str, Any], ...]:
        return self.submitted

    @property
    def effective_items(self) -> tuple[EffectiveBatchItem, ...]:
        return self.effective


# 便于调用方和未来 worker 使用的别名；语义仍只有一个结果类型。
NormalizedBatch = NormalizedPublishBatch


def _error(index: int, message: str) -> NormalizationError:
    return NormalizationError(f"第 {index + 1} 个 item：{message}")


def _as_mapping(value: Any, index: int, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _error(index, f"{label} 必须是 object")
    return value


def _copy_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    return deepcopy(dict(value))


def _validate_platform_fields(
    value: Any,
    index: int,
    label: str = "platformFields",
) -> dict[str, dict[str, Any]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise _error(index, f"{label} 必须是 object")

    fields: dict[str, dict[str, Any]] = {}
    for platform, section in value.items():
        if platform not in _PLATFORM_FIELD_KEYS:
            raise _error(index, f"{label} 平台非法：{platform!r}")
        if not isinstance(section, Mapping):
            raise _error(index, f"{label}.{platform} 必须是 object")
        unknown = set(section) - _PLATFORM_FIELD_KEYS[platform]
        if unknown:
            raise _error(index, f"{platform} 字段非法：{sorted(unknown)}")
        value_field = "source" if platform == "xiaohongshu" else "declaration"
        value = section.get(value_field)
        if value is not None and not isinstance(value, str):
            raise _error(
                index,
                f"{label}.{platform}.{value_field} 必须是 string 或 null",
            )
        if (
            "origin" in section
            and section["origin"] is not None
            and not isinstance(section["origin"], bool)
        ):
            raise _error(index, f"{label}.{platform}.origin 必须是 boolean 或 null")
        fields[platform] = _copy_mapping(section)

    try:
        # 复用声明枚举唯一映射真源，保证默认值和任务值同样严格校验。
        resolve_platform_fields(fields)
    except DeclarationMappingError as err:
        raise _error(index, str(err)) from err
    return fields


def _normalize_account(
    raw: AccountSnapshot | Mapping[str, Any], index: int
) -> AccountSnapshot:
    if isinstance(raw, AccountSnapshot):
        account_id = raw.account_id
        platform_type = raw.platform_type
        file_path = raw.file_path
        user_name = raw.user_name
        status = raw.status
        default_fields: Any = raw.default_platform_fields
    else:
        account = _as_mapping(raw, index, "账号")
        account_id = account.get("id")
        platform_type = account.get("type", account.get("platform_type"))
        file_path = account.get("filePath", account.get("file_path"))
        user_name = account.get("userName", account.get("user_name", ""))
        status = account.get("status")
        default_fields = account.get(
            "default_platform_fields", account.get("defaultPlatformFields")
        )
        if isinstance(default_fields, str):
            try:
                default_fields = json.loads(default_fields)
            except (TypeError, ValueError) as err:
                raise NormalizationError("账号默认声明不是合法 JSON") from err

    if isinstance(account_id, bool) or not isinstance(account_id, int):
        raise NormalizationError("账号快照缺少合法 id")
    if (
        isinstance(platform_type, bool)
        or not isinstance(platform_type, int)
        or platform_type not in _SUPPORTED_PLATFORM_TYPES
    ):
        raise NormalizationError(f"账号快照平台非法：{platform_type!r}")
    if not isinstance(file_path, str) or not file_path.strip():
        raise NormalizationError("账号快照缺少合法 filePath")
    if not isinstance(user_name, str):
        raise NormalizationError("账号快照 userName 必须是 string")
    if status is not None and (
        isinstance(status, bool) or not isinstance(status, int) or status not in {0, 1}
    ):
        raise NormalizationError("账号快照 status 必须是 0、1 或 null")

    return AccountSnapshot(
        account_id=account_id,
        platform_type=platform_type,
        file_path=file_path,
        user_name=user_name,
        status=status,
        default_platform_fields=_validate_platform_fields(
            default_fields, index, "账号默认声明"
        ),
    )


def _index_accounts(
    accounts: Iterable[AccountSnapshot | Mapping[str, Any]],
    requested_keys: set[tuple[int, str]],
) -> dict[tuple[int, str], AccountSnapshot]:
    """只校验本次请求可能命中的账号，忽略无关脏行。"""
    indexed: dict[tuple[int, str], AccountSnapshot] = {}
    requested_file_paths = {file_path for _, file_path in requested_keys}
    for index, raw in enumerate(accounts):
        if isinstance(raw, AccountSnapshot):
            file_path = raw.file_path
            platform_type = raw.platform_type
        elif isinstance(raw, Mapping):
            file_path = raw.get("filePath", raw.get("file_path"))
            platform_type = raw.get("type", raw.get("platform_type"))
        else:
            continue

        # filePath 是请求账号的稳定选择键；同路径但平台类型畸形时仍纳入，
        # 让目标行返回可读校验错误，而不是把坏目标伪装成“账号不存在”。
        if not isinstance(file_path, str) or file_path not in requested_file_paths:
            continue
        if (
            isinstance(platform_type, int)
            and not isinstance(platform_type, bool)
            and (platform_type, file_path) not in requested_keys
        ):
            continue

        snapshot = _normalize_account(raw, index)
        key = (snapshot.platform_type, snapshot.file_path)
        if key in indexed:
            raise NormalizationError(f"账号快照重复：{snapshot.file_path}")
        indexed[key] = snapshot
    return indexed


def _validate_string_list(value: Any, index: int, label: str) -> list[str]:
    if not isinstance(value, (list, tuple)) or not value:
        raise _error(index, f"{label}不能为空")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise _error(index, f"{label}必须是非空字符串数组")
    return list(value)


def _validate_optional_string(payload: Mapping[str, Any], key: str, index: int) -> None:
    if (
        key in payload
        and payload[key] is not None
        and not isinstance(payload[key], str)
    ):
        raise _error(index, f"{key}必须是 string 或 null")


def _normalize_daily_times(value: Any, index: int) -> list[str]:
    """双读旧小时与新 HH:MM，单写排序去重的 HH:MM。"""
    if not isinstance(value, (list, tuple)) or not value:
        raise _error(index, "每日时刻 dailyTimes 不能为空")

    normalized: set[str] = set()
    for raw in value:
        if isinstance(raw, bool):
            raise _error(index, "每日时刻 dailyTimes 必须是 HH:MM 字符串或旧小时整数")
        if isinstance(raw, int):
            if raw < 0 or raw > 23:
                raise _error(index, "每日时刻 dailyTimes 小时必须在 0-23")
            normalized.add(f"{raw:02d}:00")
            continue
        if not isinstance(raw, str):
            raise _error(index, "每日时刻 dailyTimes 必须是 HH:MM 字符串或旧小时整数")
        match = re.fullmatch(r"(\d{1,2}):(\d{2})", raw)
        if match is None:
            raise _error(index, "每日时刻 dailyTimes 必须是 HH:MM")
        hour, minute = (int(part) for part in match.groups())
        if hour > 23 or minute > 59:
            raise _error(index, "每日时刻 dailyTimes 必须是有效 HH:MM")
        normalized.add(f"{hour:02d}:{minute:02d}")

    return sorted(normalized)


def _local_naive_now() -> datetime:
    """读取一次机器本地时钟，供同一受理批次复用。"""
    return datetime.now(tz=UTC).astimezone().replace(tzinfo=None)


def generate_douyin_publish_datetimes(
    total_videos: int,
    videos_per_day: int,
    daily_times: list[str],
    start_days: int,
    *,
    now: datetime | None = None,
) -> list[datetime]:
    """按本地日历生成抖音最终执行时刻，返回无时区 naive datetime。"""
    if (
        isinstance(total_videos, bool)
        or not isinstance(total_videos, int)
        or total_videos < 0
    ):
        raise ValueError("total_videos 必须是非负整数")
    if (
        isinstance(videos_per_day, bool)
        or not isinstance(videos_per_day, int)
        or videos_per_day <= 0
        or videos_per_day > len(daily_times)
    ):
        raise ValueError("videos_per_day 必须在每日时刻数量范围内")
    if (
        isinstance(start_days, bool)
        or not isinstance(start_days, int)
        or start_days < 0
    ):
        raise ValueError("start_days 必须是非负整数")
    current = _local_naive_now() if now is None else now
    if not isinstance(current, datetime) or current.tzinfo is not None:
        raise ValueError("now 必须是本地 naive datetime")

    slots: list[tuple[int, int]] = []
    for raw in daily_times:
        match = re.fullmatch(r"(\d{2}):(\d{2})", raw)
        if match is None:
            raise ValueError(f"daily_times 时刻格式非法：{raw!r}")
        hour, minute = (int(part) for part in match.groups())
        if hour > 23 or minute > 59:
            raise ValueError(f"daily_times 时刻越界：{raw!r}")
        slots.append((hour, minute))

    return [
        datetime.combine(
            current.date() + timedelta(days=video // videos_per_day + start_days + 1),
            time(*slots[video % videos_per_day]),
        )
        for video in range(total_videos)
    ]


def _validate_schedule(payload: dict[str, Any], index: int) -> bool:
    enabled = payload.get("enableTimer", False)
    if enabled is None:
        enabled = False
    if not isinstance(enabled, bool):
        raise _error(index, "enableTimer必须是 boolean")
    if not enabled:
        return False

    videos_per_day = payload.get("videosPerDay")
    if (
        isinstance(videos_per_day, bool)
        or not isinstance(videos_per_day, int)
        or videos_per_day <= 0
    ):
        raise _error(index, "每日条数 videosPerDay 必须是正整数")

    normalized_daily_times = _normalize_daily_times(payload.get("dailyTimes"), index)
    if videos_per_day > len(normalized_daily_times):
        raise _error(index, "每日条数不能超过时刻数量")
    # effective payload 的唯一写入形态；旧整数只在读取时转换。
    payload["dailyTimes"] = normalized_daily_times

    start_days = payload.get("startDays")
    if (
        isinstance(start_days, bool)
        or not isinstance(start_days, int)
        or start_days < 0
    ):
        raise _error(index, "起始天 startDays 必须是非负整数")
    return True


def _validate_and_copy_submitted(
    raw: Mapping[str, Any], index: int
) -> tuple[dict[str, Any], int, list[str], list[str], dict[str, dict[str, Any]], bool]:
    payload = _copy_mapping(raw)
    platform_type = payload.get("type")
    if (
        isinstance(platform_type, bool)
        or not isinstance(platform_type, int)
        or platform_type not in _SUPPORTED_PLATFORM_TYPES
    ):
        raise _error(index, f"平台类型非法：{platform_type!r}")

    files = _validate_string_list(payload.get("fileList"), index, "文件列表（素材）")
    account_files = _validate_string_list(payload.get("accountList"), index, "账号列表")
    if len(set(account_files)) != len(account_files):
        raise _error(index, "账号列表包含重复账号")

    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise _error(index, "标题不能为空")

    tags = payload.get("tags", [])
    if tags is None:
        tags = []
    if not isinstance(tags, (list, tuple)) or any(
        not isinstance(tag, str) for tag in tags
    ):
        raise _error(index, "tags 必须是字符串数组")

    category = payload.get("category")
    if category is not None and (
        isinstance(category, bool) or not isinstance(category, int)
    ):
        raise _error(index, "category 必须是整数或 null")
    if category == 0:
        # 与官方路由保持一致：0 在进入发布函数前转换为 None。
        payload["category"] = None

    for key in ("thumbnail", "productLink", "productTitle"):
        _validate_optional_string(payload, key, index)
    if "isDraft" in payload and not isinstance(payload["isDraft"], bool):
        raise _error(index, "isDraft 必须是 boolean")

    if "platformFields" in payload and "platform_fields" in payload:
        raise _error(index, "platformFields 与 platform_fields 不能同时提供")
    raw_platform_fields = payload.get(
        "platformFields", payload.pop("platform_fields", None)
    )
    platform_fields = _validate_platform_fields(raw_platform_fields, index)
    if platform_fields:
        payload["platformFields"] = platform_fields
    else:
        payload.pop("platformFields", None)
    timer_enabled = _validate_schedule(payload, index)
    payload["fileList"] = files
    payload["accountList"] = account_files
    payload["tags"] = list(tags)
    payload["enableTimer"] = timer_enabled
    if not timer_enabled:
        # 官方在立即模式忽略这些键；移除后可保证不同入口产生同一可回放命令。
        for key in ("videosPerDay", "dailyTimes", "startDays"):
            payload.pop(key, None)
    else:
        payload["dailyTimes"] = list(payload["dailyTimes"])
    return payload, platform_type, files, account_files, platform_fields, timer_enabled


def _merge_selected_platform_fields(
    platform_type: int,
    defaults: Mapping[str, Any],
    submitted: Mapping[str, dict[str, Any]],
    index: int,
) -> dict[str, dict[str, Any]]:
    platform_name = _PLATFORM_NAMES[platform_type]
    selected: dict[str, Any] = {}
    default_section = defaults.get(platform_name)
    if default_section is not None:
        if not isinstance(default_section, Mapping):
            raise _error(index, f"账号默认声明.{platform_name} 必须是 object")
        selected.update(
            {
                key: deepcopy(value)
                for key, value in default_section.items()
                if value is not None
            }
        )
    task_section = submitted.get(platform_name)
    if task_section is not None:
        selected.update(
            {
                key: deepcopy(value)
                for key, value in task_section.items()
                if value is not None
            }
        )
    return {platform_name: selected} if selected else {}


def _validate_execution_fields(
    platform_type: int,
    fields: Mapping[str, dict[str, Any]],
    index: int,
) -> None:
    """拒绝没有可靠执行 seam 的有效字段，避免静默错发。"""
    platform_name = _PLATFORM_NAMES[platform_type]
    unsupported = sorted(
        key
        for key in _UNSUPPORTED_EXECUTION_FIELDS.get(platform_name, set())
        if fields.get(platform_name, {}).get(key) is not None
    )
    if unsupported:
        raise _error(
            index,
            f"{platform_name} 字段暂不支持安全执行：{unsupported}",
        )


def normalize_publish_payloads(
    payloads: Iterable[Mapping[str, Any]],
    accounts: Iterable[AccountSnapshot | Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> NormalizedPublishBatch:
    """将单视频或旧批量请求规范化为账号粒度的有效命令。

    `payloads` 仍使用官方 `/postVideo` 与 `/postVideoBatch` 的请求体；单个
    item 的多个账号会拆成多个 effective item。所有校验和快照均在返回前完成，
    调用方可以放心在之后才进入官方发布 seam。
    """
    raw_items = list(payloads)
    if not raw_items:
        raise NormalizationError("发布 item 不能为空")

    submitted: list[dict[str, Any]] = []
    snapshot_now = now
    prepared: list[
        tuple[
            int,
            dict[str, Any],
            list[str],
            list[str],
            dict[str, dict[str, Any]],
        ]
    ] = []
    # 先完整校验整批，再查账号并展开。这样批量中后续 item 的结构错误
    # 会优先于任何执行前的账号/副作用路径暴露。
    for index, raw in enumerate(raw_items):
        mapping = _as_mapping(raw, index, "item")
        (
            submitted_payload,
            platform_type,
            files,
            account_files,
            platform_fields,
            _timer_enabled,
        ) = _validate_and_copy_submitted(mapping, index)
        submitted.append(deepcopy(dict(mapping)))
        prepared.append(
            (platform_type, submitted_payload, files, account_files, platform_fields)
        )

    requested_account_keys = {
        (platform_type, account_file)
        for platform_type, _payload, _files, account_files, _platform_fields in prepared
        for account_file in account_files
    }
    account_index = _index_accounts(accounts, requested_account_keys)
    effective: list[EffectiveBatchItem] = []
    for index, (
        platform_type,
        submitted_payload,
        files,
        account_files,
        platform_fields,
    ) in enumerate(prepared):
        for account_file in account_files:
            snapshot = account_index.get((platform_type, account_file))
            if snapshot is None:
                raise _error(
                    index,
                    f"账号快照不存在或平台不匹配：{_PLATFORM_NAMES[platform_type]}/{account_file}",
                )
            selected_fields = _merge_selected_platform_fields(
                platform_type,
                snapshot.default_platform_fields,
                platform_fields,
                index,
            )
            _validate_execution_fields(platform_type, selected_fields, index)
            command = deepcopy(submitted_payload)
            command["fileList"] = list(files)
            command["accountList"] = [snapshot.file_path]
            if platform_type == 3 and command.get("enableTimer"):
                if snapshot_now is None:
                    snapshot_now = _local_naive_now()
                command["publishDatetimes"] = [
                    value.isoformat(timespec="seconds")
                    for value in generate_douyin_publish_datetimes(
                        len(files),
                        command["videosPerDay"],
                        command["dailyTimes"],
                        command["startDays"],
                        now=snapshot_now,
                    )
                ]
            if selected_fields:
                command["platformFields"] = selected_fields
            else:
                command.pop("platformFields", None)
            effective.append(
                EffectiveBatchItem(
                    source_index=index,
                    platform_type=platform_type,
                    account_snapshot=snapshot,
                    submitted=deepcopy(submitted[index]),
                    effective=command,
                )
            )

    return NormalizedPublishBatch(tuple(submitted), tuple(effective))


def normalize_publish_payload(
    payload: Mapping[str, Any],
    accounts: Iterable[AccountSnapshot | Mapping[str, Any]],
    *,
    now: datetime | None = None,
) -> NormalizedPublishBatch:
    """单视频入口的命名别名，和旧批量入口共用实现。"""
    return normalize_publish_payloads([payload], accounts, now=now)


class PublishExecutionAdapter:
    """先规范化，再逐个委托官方函数的最薄执行入口。

    `invoke_official` 是唯一副作用 seam。适配器本身不实现浏览器、定时、
    重试或并发策略；规范化失败时保证该回调一次都不会被调用。
    """

    def __init__(self, invoke_official: Callable[[dict[str, Any]], Any]) -> None:
        self._invoke_official = invoke_official

    def execute_item(self, item: EffectiveBatchItem) -> Any:
        """执行一个已完成规范化的 item；供官方 route wrapper 复用。"""
        return self._invoke_official(deepcopy(item.effective))

    def execute(
        self,
        payloads: Iterable[Mapping[str, Any]],
        accounts: Iterable[AccountSnapshot | Mapping[str, Any]],
    ) -> NormalizedPublishBatch:
        normalized = normalize_publish_payloads(payloads, accounts)
        for item in normalized.effective:
            self.execute_item(item)
        return normalized
