"""真实发布执行器（issue #20）：构建上游 uploader + cdp_attach 接管账号 Chrome。

ADR-0001 §上传执行：

    async def execute(job, account):
        app = build_uploader(job.platform, job)   # DouYinVideo / XiaoHongShuVideo / TencentVideo
        async with cdp_attach(f"http://127.0.0.1:{account.cdp_port}", is_local=True) as pw:
            await app.upload(pw)                   # 上游 100% 编排（T1 方案 B）

不 fork 上游：唯一注入面是 playwright 实例（patch `chromium.launch` → `connect_over_cdp`，
见 `posthub.cdp_attach`）。上游三个平台 uploader 的 `upload(self, playwright)` 方法签名统一，
本模块按平台实例化并把 CDP 接管的 `pw` 传入。

真实上传（真实 Chrome + 登录态 + 平台 UI）属 #11 验收门；本模块保证代码就绪 + seam 正确。
"""

from __future__ import annotations

import importlib
import socket
import urllib.error
from datetime import datetime
from typing import Any, Callable

import conf
from posthub.accounts import default_data_dir
from posthub.cdp_attach import cdp_attach
from posthub.engine import ExecutionContext, TaskSpec, UploadResult
from posthub.state import TIME_FMT

__all__ = [
    "PLATFORM_UPLOADERS",
    "HIGH_RISK_PLATFORMS",
    "account_cookie_file",
    "build_uploader",
    "resolve_headless",
    "UpstreamUploadExecutor",
    "classify_upload_error",
]

# 平台枚举（CONTEXT.md）→ 上游模块路径 + uploader 类名
# 注：douyin/xhs 的 uploader 类定义在 `main` 子模块（包 __init__ 不导出），统一指向 `.main`。
PLATFORM_UPLOADERS: dict[str, tuple[str, str]] = {
    "douyin": ("uploader.douyin_uploader.main", "DouYinVideo"),
    "xiaohongshu": ("uploader.xiaohongshu_uploader.main", "XiaoHongShuVideo"),
    "wechat": ("uploader.tencent_uploader.main", "TencentVideo"),
}

# 强风控平台集合（issue #21）：抖音 / 小红书 / 视频号三平台统一判定为强风控，
# 默认使用可见浏览器（headless=False）以降低机器判定风险；待真实账号实测数据后再细分。
HIGH_RISK_PLATFORMS: frozenset[str] = frozenset(
    {"douyin", "xiaohongshu", "wechat"}
)

# 上游三个平台的发布策略常量统一为 "immediate" / "scheduled"
_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
_PUBLISH_STRATEGY_SCHEDULED = "scheduled"


def resolve_headless(platform: str, conf, *, silent: bool = False) -> bool:
    """按平台决策浏览器可见性（issue #21 seam #2）。

    强风控平台默认可见浏览器（headless=False）以降低机器判定风险；以下两者
    显式要求后台静默 → headless=True：
    - `silent=True`（任务级「静默发布」开关，不打扰 / 无弹窗）；
    - `conf.LOCAL_CHROME_HEADLESS=True`（用户全局要求后台运行）。
    非强风控平台默认 headless=True（静默）。

    `conf` 鸭子类型：只需 `LOCAL_CHROME_HEADLESS` 字段（真实传 `conf` 模块）。
    """
    if silent:
        return True
    if getattr(conf, "LOCAL_CHROME_HEADLESS", False):
        return True
    return platform not in HIGH_RISK_PLATFORMS


def account_cookie_file(account_id: str) -> str:
    """该账号的上游 cookie JSON 路径（PostHub 数据目录下）。

    上游 uploader 用 `storage_state` 读写该文件；Phase 1 只负责路径就绪，
    真实登录态同步（`context.storage_state`）属 #11。
    """
    return str(default_data_dir() / "cookies" / f"{account_id}.json")


def _platform_scheduled_publish_date(spec: TaskSpec) -> datetime | None:
    """platform_time 定时 → 平台原生排期时间（datetime）；否则 None（立即发布）。

    `local_time`（工具到点兜底）由调度器到点才领取，仍走立即发布；只有
    `platform_time` 定时才把 `publish_at` 交给上游做平台原生排期。
    """
    if spec.publish_mode != "platform_time" or not spec.publish_at:
        return None
    try:
        return datetime.strptime(spec.publish_at, TIME_FMT)
    except ValueError:
        return None


def _cover_kwargs(platform: str, spec: TaskSpec) -> dict[str, Any]:
    """按平台把 PostHub 封面字段映射到上游构造参数（issue #16 封面落地）。

    - 抖音：横版 `thumbnail_landscape_path` / 竖版 `thumbnail_portrait_path`
    - 小红书：主封面 3:4 竖版优先，缺省回退横版 `thumbnail_path`
    - 视频号：横版 / 竖版均可（`thumbnail_landscape_path` / `thumbnail_portrait_path`）
    """
    if platform == "xiaohongshu":
        cover = spec.cover_vertical or spec.cover_horizontal
        return {"thumbnail_path": cover} if cover else {}
    kwargs: dict[str, Any] = {}
    if spec.cover_horizontal:
        kwargs["thumbnail_landscape_path"] = spec.cover_horizontal
    if spec.cover_vertical:
        kwargs["thumbnail_portrait_path"] = spec.cover_vertical
    return kwargs


def _uploader_kwargs(platform: str, spec: TaskSpec) -> dict[str, Any]:
    """构造上游 uploader 的共用构造参数。"""
    publish_date = _platform_scheduled_publish_date(spec)
    kwargs: dict[str, Any] = {
        "title": spec.title,
        "file_path": spec.video_path,
        "tags": list(spec.tags),
        "publish_date": publish_date or 0,
        "account_file": account_cookie_file(spec.account_id),
        "desc": spec.caption,
        # platform_time 定时 → 上游原生排期；其余（立即 / local_time 兜底）→ 立即发布
        "publish_strategy": (
            _PUBLISH_STRATEGY_SCHEDULED
            if publish_date is not None
            else _PUBLISH_STRATEGY_IMMEDIATE
        ),
        "debug": conf.DEBUG_MODE,
        "headless": resolve_headless(platform, conf, silent=spec.silent),
    }
    kwargs.update(_cover_kwargs(platform, spec))
    return kwargs


def build_uploader(platform: str, spec: TaskSpec):
    """按平台实例化上游 uploader（DouYinVideo / XiaoHongShuVideo / TencentVideo）。

    构造不触发上传校验（上游在 `upload()` 内的 `validate_upload_args` 校验）。
    未知平台抛 `KeyError`。
    """
    module_name, class_name = PLATFORM_UPLOADERS[platform]
    module = importlib.import_module(module_name)
    cls = getattr(module, class_name)
    return cls(**_uploader_kwargs(platform, spec))


def classify_upload_error(exc: Exception) -> str:
    """上传异常分类（CONTEXT.md 错误类型）：网络类 → `network`，其余 → `unknown`。

    上游 patchright 抛错类型繁多无法穷举，按类型 + 消息特征启发式判定，
    保证网络瞬时失败进入调度器重试分支（#17 网络类重试 2 次退避）而非直接转人工。
    """
    if isinstance(exc, (socket.timeout, urllib.error.URLError)):
        return "network"
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return "network"
    message = str(exc).lower()
    for keyword in (
        "timeout",
        "timed out",
        "connection",
        "refused",
        "reset",
        "network",
        "cannot connect",
    ):
        if keyword in message:
            return "network"
    return "unknown"


class UpstreamUploadExecutor:
    """`BrowserExecutor` 实现：build_uploader → cdp_attach 接管账号 Chrome → app.upload(pw)。

    依赖注入：`uploader_factory` / `attach` 供测试替换；缺省用 `build_uploader` /
    `cdp_attach`。异常按 `classify_upload_error` 分类（网络类进入重试分支，
    其余 unknown → 转人工），终态由调度层决定。
    """

    def __init__(
        self,
        uploader_factory: Callable = build_uploader,
        attach: Callable = cdp_attach,
    ) -> None:
        self._uploader_factory = uploader_factory
        self._attach = attach

    async def upload(self, spec: TaskSpec, context: ExecutionContext) -> UploadResult:
        app = self._uploader_factory(spec.platform, spec)
        # 把账号 Chrome 登录态导出到上游要求的 account_file（~/.posthub/cookies/{id}.json），
        # 否则上游 validate_upload_args 报「cookie文件不存在」。
        account_file = account_cookie_file(spec.account_id)
        try:
            async with self._attach(
                context.account.cdp_url,
                is_local=True,
                storage_state_path=account_file,
            ) as pw:
                await app.upload(pw)  # 上游 100% 编排
        except Exception as exc:
            return UploadResult(
                ok=False,
                error_type=classify_upload_error(exc),
                message=str(exc),
            )
        return UploadResult(ok=True)
