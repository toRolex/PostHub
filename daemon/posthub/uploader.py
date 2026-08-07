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
from typing import Any, Callable

import conf
from posthub.accounts import default_data_dir
from posthub.cdp_attach import cdp_attach
from posthub.engine import ExecutionContext, TaskSpec, UploadResult

__all__ = [
    "PLATFORM_UPLOADERS",
    "HIGH_RISK_PLATFORMS",
    "account_cookie_file",
    "build_uploader",
    "resolve_headless",
    "UpstreamUploadExecutor",
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

# 上游三个平台的立即发布策略常量统一为 "immediate"
_PUBLISH_STRATEGY_IMMEDIATE = "immediate"


def resolve_headless(platform: str, conf) -> bool:
    """按平台决策浏览器可见性（issue #21 seam #2）。

    强风控平台默认可见浏览器（headless=False）以降低机器判定风险；配置可覆盖：
    `conf.LOCAL_CHROME_HEADLESS=True`（用户显式要求后台静默）→ 全部平台 headless。
    非强风控平台默认 headless=True（静默）。

    `conf` 鸭子类型：只需 `LOCAL_CHROME_HEADLESS` 字段（真实传 `conf` 模块）。
    """
    if getattr(conf, "LOCAL_CHROME_HEADLESS", False):
        return True
    return platform not in HIGH_RISK_PLATFORMS


def account_cookie_file(account_id: str) -> str:
    """该账号的上游 cookie JSON 路径（PostHub 数据目录下）。

    上游 uploader 用 `storage_state` 读写该文件；Phase 1 只负责路径就绪，
    真实登录态同步（`context.storage_state`）属 #11。
    """
    return str(default_data_dir() / "cookies" / f"{account_id}.json")


def _uploader_kwargs(platform: str, spec: TaskSpec) -> dict[str, Any]:
    """构造上游 uploader 的共用构造参数。"""
    return {
        "title": spec.title,
        "file_path": spec.video_path,
        "tags": list(spec.tags),
        "publish_date": 0,  # Phase 1：立即发布（定时双模式由调度层解析后传入）
        "account_file": account_cookie_file(spec.account_id),
        "desc": spec.caption,
        "publish_strategy": _PUBLISH_STRATEGY_IMMEDIATE,
        "debug": conf.DEBUG_MODE,
        "headless": resolve_headless(platform, conf),
    }


def build_uploader(platform: str, spec: TaskSpec):
    """按平台实例化上游 uploader（DouYinVideo / XiaoHongShuVideo / TencentVideo）。

    构造不触发上传校验（上游在 `upload()` 内的 `validate_upload_args` 校验）。
    未知平台抛 `KeyError`。
    """
    module_name, class_name = PLATFORM_UPLOADERS[platform]
    module = importlib.import_module(module_name)
    cls = getattr(module, class_name)
    return cls(**_uploader_kwargs(platform, spec))


class UpstreamUploadExecutor:
    """`BrowserExecutor` 实现：build_uploader → cdp_attach 接管账号 Chrome → app.upload(pw)。

    依赖注入：`uploader_factory` / `attach` 供测试替换；缺省用 `build_uploader` /
    `cdp_attach`。异常映射到 `unknown`（CONTEXT.md 错误类型），终态由调度层决定。
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
        try:
            async with self._attach(context.account.cdp_url, is_local=True) as pw:
                await app.upload(pw)  # 上游 100% 编排
        except Exception as exc:
            return UploadResult(ok=False, error_type="unknown", message=str(exc))
        return UploadResult(ok=True)
