"""任务执行引擎 seam 测试：execute(task_spec, context) -> job_updates + fake 浏览器执行器注入。

唯一 seam（CONTEXT.md）：调度 / 状态机 / 重试为纯领域逻辑，浏览器执行器经依赖注入替换。
测试只断言 seam 外部行为：task_spec + fake 执行器 → job_updates。
"""

from __future__ import annotations

import asyncio

from posthub.engine import (
    AccountContext,
    ExecutionContext,
    TaskSpec,
    UploadResult,
    execute,
)


def run(coro):
    return asyncio.run(coro)


class FakeExecutor:
    """fake 浏览器执行器：记录调用、返回预设结果。"""

    def __init__(self, result: UploadResult):
        self.result = result
        self.calls: list[tuple[TaskSpec, ExecutionContext]] = []

    async def upload(self, spec: TaskSpec, context: ExecutionContext) -> UploadResult:
        self.calls.append((spec, context))
        return self.result


def make_spec(**overrides) -> TaskSpec:
    base = dict(
        task_id="task-1",
        platform="douyin",
        account_id="acc-1",
        video_path="/tmp/video.mp4",
        title="标题",
    )
    base.update(overrides)
    return TaskSpec(**base)


def make_context() -> ExecutionContext:
    return ExecutionContext(
        account=AccountContext(
            account_id="acc-1",
            platform="douyin",
            cdp_url="http://127.0.0.1:9222",
        )
    )


def test_execute_success_emits_publishing_then_success() -> None:
    spec = make_spec()
    ctx = make_context()
    fake = FakeExecutor(UploadResult(ok=True, post_id="p123", post_url="https://example.com/p123"))

    updates = run(execute(spec, ctx, fake))

    assert [u.status for u in updates] == ["publishing", "success"]
    final = updates[-1]
    assert final.job_id == "task-1:douyin"
    assert final.task_id == "task-1"
    assert final.platform == "douyin"
    assert final.post_id == "p123"
    assert final.post_url == "https://example.com/p123"
    assert len(fake.calls) == 1
    assert fake.calls[0][0] is spec


def test_execute_auth_error_maps_to_needs_relogin() -> None:
    fake = FakeExecutor(UploadResult(ok=False, error_type="auth", message="登录态失效"))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].status == "needs_relogin"
    assert updates[-1].message == "登录态失效"


def test_execute_network_error_maps_to_failed() -> None:
    fake = FakeExecutor(UploadResult(ok=False, error_type="network", message="timeout"))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].status == "failed"


def test_execute_risk_control_maps_to_manual() -> None:
    fake = FakeExecutor(UploadResult(ok=False, error_type="risk_control"))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].status == "manual"


def test_execute_platform_reject_maps_to_failed() -> None:
    fake = FakeExecutor(UploadResult(ok=False, error_type="platform_reject"))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].status == "failed"


def test_execute_unknown_error_maps_to_manual() -> None:
    fake = FakeExecutor(UploadResult(ok=False, error_type=None))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].status == "manual"


def test_execute_error_update_carries_error_type() -> None:
    """调度器重试判定依赖 JobUpdate.error_type。"""
    fake = FakeExecutor(UploadResult(ok=False, error_type="network", message="timeout"))
    updates = run(execute(make_spec(), make_context(), fake))
    assert updates[-1].error_type == "network"
    assert updates[-1].message == "timeout"
    fake2 = FakeExecutor(UploadResult(ok=True, post_id="p1"))
    updates2 = run(execute(make_spec(), make_context(), fake2))
    assert updates2[-1].error_type is None
    assert updates2[-1].post_id == "p1"


def test_executor_is_injected_not_imported() -> None:
    """seam 之外不应依赖任何真实浏览器实现；注入即可替换。"""
    fake = FakeExecutor(UploadResult(ok=True))
    spec = make_spec(platform="xiaohongshu", account_id="acc-2")
    ctx = ExecutionContext(
        account=AccountContext(
            account_id="acc-2",
            platform="xiaohongshu",
            cdp_url="http://127.0.0.1:9223",
        )
    )
    updates = run(execute(spec, ctx, fake))
    assert updates[-1].status == "success"
    assert fake.calls[0][1].account.cdp_url == "http://127.0.0.1:9223"
