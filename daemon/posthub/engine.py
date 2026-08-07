"""任务执行引擎 seam。

本项目唯一 seam（CONTEXT.md）：

    execute(task_spec, context) -> job_updates

- 调度 / 状态机 / 重试 / 限速 / 并发为纯领域逻辑（后续 issue）。
- 浏览器执行器经依赖注入替换：`execute(..., executor)`，seam 之外不感知真实浏览器。
- 测试只断言 seam 外部行为：`task_spec` + fake 执行器 → `job_updates`。

错误 → 终态映射（CONTEXT.md 重试策略，调度层负责退避重试）：

| error_type        | status         |
|-------------------|----------------|
| network           | failed         | 网络重试用尽
| auth              | needs_relogin  | 登录态失效 → 需重新扫码
| risk_control      | manual         | 风控拦截 → 转人工
| platform_reject   | failed         | 平台拒绝且不可降级
| unknown           | manual         | 其他 → 转人工
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Platform = Literal["douyin", "xiaohongshu", "wechat"]
JobStatus = Literal[
    "pending",
    "publishing",
    "success",
    "failed",
    "manual",
    "needs_relogin",
    "missed",
]
ErrorType = Literal["network", "auth", "risk_control", "platform_reject", "unknown"]

__all__ = [
    "Platform",
    "JobStatus",
    "ErrorType",
    "TaskSpec",
    "AccountContext",
    "ExecutionContext",
    "UploadResult",
    "JobUpdate",
    "BrowserExecutor",
    "execute",
]


@dataclass(frozen=True)
class TaskSpec:
    """一次发布的最小描述（task 级共享源值 + 平台 + 账号）。"""

    task_id: str
    platform: Platform
    account_id: str
    video_path: str
    title: str = ""
    caption: str = ""
    tags: tuple[str, ...] = ()
    cover_horizontal: str | None = None
    cover_vertical: str | None = None
    publish_mode: Literal["platform_time", "local_time"] = "platform_time"
    publish_at: str | None = None
    platform_fields: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AccountContext:
    """账号上下文：cdp_url 为 connect_over_cdp 的调试端口地址。"""

    account_id: str
    platform: Platform
    cdp_url: str  # http://127.0.0.1:{cdp_port}
    name: str = ""


@dataclass(frozen=True)
class ExecutionContext:
    """执行上下文：账号 + 配置（conf 字段等）。"""

    account: AccountContext
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class UploadResult:
    """执行器返回的发布结果。ok=False 时 error_type 驱动状态映射。"""

    ok: bool
    post_id: str | None = None
    post_url: str | None = None
    error_type: ErrorType | None = None
    message: str | None = None


class BrowserExecutor(Protocol):
    """浏览器执行器：seam 之外的注入点。

    真实实现基于 social-auto-upload（patchright），经 `connect_over_cdp`
    接管账号 Chrome（登录态天然持久化），见 ADR-0001 §上传执行。
    """

    async def upload(self, spec: TaskSpec, context: ExecutionContext) -> UploadResult:
        ...


@dataclass(frozen=True)
class JobUpdate:
    """一次 job 状态变更事件（job_updates 流的元素）。"""

    job_id: str
    task_id: str
    platform: Platform
    status: JobStatus
    post_id: str | None = None
    post_url: str | None = None
    message: str | None = None
    attempt_count: int = 1


_TERMINAL_BY_ERROR: dict[ErrorType, JobStatus] = {
    "network": "failed",
    "auth": "needs_relogin",
    "risk_control": "manual",
    "platform_reject": "failed",
    "unknown": "manual",
}


async def execute(
    spec: TaskSpec,
    context: ExecutionContext,
    executor: BrowserExecutor,
) -> list[JobUpdate]:
    """执行一次发布，返回 job_updates 流。

    先发出 `publishing`，再经注入的 executor 执行，最后按结果映射终态。
    浏览器真实执行在 seam 之外（executor 注入）；本函数只编排状态。
    """
    job_id = f"{spec.task_id}:{spec.platform}"
    updates: list[JobUpdate] = [
        JobUpdate(
            job_id=job_id,
            task_id=spec.task_id,
            platform=spec.platform,
            status="publishing",
        )
    ]

    result = await executor.upload(spec, context)
    if result.ok:
        updates.append(
            JobUpdate(
                job_id=job_id,
                task_id=spec.task_id,
                platform=spec.platform,
                status="success",
                post_id=result.post_id,
                post_url=result.post_url,
            )
        )
    else:
        terminal = _TERMINAL_BY_ERROR.get(result.error_type or "unknown", "manual")
        updates.append(
            JobUpdate(
                job_id=job_id,
                task_id=spec.task_id,
                platform=spec.platform,
                status=terminal,
                message=result.message,
            )
        )
    return updates
