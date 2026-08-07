"""人工介入事件测试（issue #21 seam #1）。

- `InMemoryInterventionHub`：notify / pending / acknowledge 生命周期。
- 调度器在 job 进入 `manual`（验证码/风控）或 `needs_relogin`（登录态失效）时，
  经注入的 notifier 发出可观测事件；网络类自动重试不产生人工介入事件。
"""

from __future__ import annotations

import asyncio

from posthub.accounts import InMemoryAccountStore, NewAccount
from posthub.engine import UploadResult
from posthub.interventions import InMemoryInterventionHub, NewIntervention
from posthub.scheduler import Scheduler
from posthub.tasks import (
    InMemoryTaskStore,
    NewTaskSpec,
    PlatformJobSpec,
)

T0 = "2026-08-08 00:00:00"


def run(coro):
    return asyncio.run(coro)


def make_stores():
    accounts = InMemoryAccountStore()
    accounts.create(
        NewAccount(
            platform="douyin",
            name="抖音一号",
            profile_dir="/tmp/p-dy",
            cdp_port=9222,
        )
    )
    task_store = InMemoryTaskStore(accounts)
    task, jobs = task_store.create_task(
        NewTaskSpec(
            title="标题",
            video_path="/tmp/v.mp4",
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    return task_store, accounts, task, jobs


class ResultExecutor:
    """fake 执行器：返回预设 UploadResult。"""

    def __init__(self, result: UploadResult):
        self.result = result

    async def upload(self, spec, context) -> UploadResult:
        return self.result


class RaisingExecutor:
    async def upload(self, spec, context) -> UploadResult:
        raise RuntimeError("boom")


# ---- InMemoryInterventionHub 生命周期 ----

def test_hub_notify_pending_acknowledge() -> None:
    hub = InMemoryInterventionHub()
    iv = hub.notify(
        NewIntervention(
            kind="manual",
            job_id=1,
            task_id=1,
            account_id=1,
            platform="douyin",
            message="验证码",
            error_type="risk_control",
            created_at=T0,
        )
    )
    assert iv.id == 1
    assert hub.pending() == [iv]
    assert hub.acknowledge(1) is True
    assert hub.pending() == []
    assert hub.acknowledge(1) is False  # 已 ack


def test_hub_to_dict_exposes_kind_and_refs() -> None:
    hub = InMemoryInterventionHub()
    iv = hub.notify(
        NewIntervention(
            kind="needs_relogin",
            job_id=7,
            task_id=3,
            account_id=2,
            platform="wechat",
            message="登录失效",
            error_type="auth",
            created_at=T0,
        )
    )
    d = iv.to_dict()
    assert d["kind"] == "needs_relogin"
    assert d["job_id"] == 7
    assert d["task_id"] == 3
    assert d["account_id"] == 2
    assert d["platform"] == "wechat"
    assert d["error_type"] == "auth"
    assert d["created_at"] == T0


# ---- 调度器 → 人工介入事件 ----

def test_risk_control_emits_manual_intervention(stores=None) -> None:
    task_store, accounts, task, jobs = make_stores()
    hub = InMemoryInterventionHub()
    sched = Scheduler(
        task_store,
        accounts,
        ResultExecutor(UploadResult(ok=False, error_type="risk_control", message="风控")),
        notifier=hub,
    )
    run(sched.tick(T0))

    pending = hub.pending()
    assert len(pending) == 1
    iv = pending[0]
    assert iv.kind == "manual"
    assert iv.job_id == jobs[0].id
    assert iv.task_id == task.id
    assert iv.account_id == 1
    assert iv.platform == "douyin"
    assert iv.message == "风控"
    assert iv.error_type == "risk_control"
    # 状态机照常落库
    assert task_store.list_jobs(task.id)[0].status == "manual"


def test_auth_emits_needs_relogin_intervention() -> None:
    task_store, accounts, task, jobs = make_stores()
    hub = InMemoryInterventionHub()
    sched = Scheduler(
        task_store,
        accounts,
        ResultExecutor(UploadResult(ok=False, error_type="auth", message="登录失效")),
        notifier=hub,
    )
    run(sched.tick(T0))

    pending = hub.pending()
    assert len(pending) == 1
    iv = pending[0]
    assert iv.kind == "needs_relogin"
    assert iv.job_id == jobs[0].id
    assert iv.message == "登录失效"
    assert iv.error_type == "auth"
    # 账号顺带置位
    assert accounts.get(1).status == "needs_relogin"


def test_executor_exception_emits_manual_intervention() -> None:
    task_store, accounts, task, jobs = make_stores()
    hub = InMemoryInterventionHub()
    sched = Scheduler(task_store, accounts, RaisingExecutor(), notifier=hub)
    run(sched.tick(T0))

    pending = hub.pending()
    assert len(pending) == 1
    assert pending[0].kind == "manual"
    assert pending[0].error_type == "unknown"
    assert pending[0].message == "boom"


def test_success_no_intervention() -> None:
    task_store, accounts, task, jobs = make_stores()
    hub = InMemoryInterventionHub()
    sched = Scheduler(
        task_store,
        accounts,
        ResultExecutor(UploadResult(ok=True, post_id="p", post_url="https://e/p")),
        notifier=hub,
    )
    run(sched.tick(T0))

    assert hub.pending() == []
    assert task_store.list_jobs(task.id)[0].status == "success"


def test_network_retry_no_intervention() -> None:
    task_store, accounts, task, jobs = make_stores()
    hub = InMemoryInterventionHub()
    sched = Scheduler(
        task_store,
        accounts,
        ResultExecutor(UploadResult(ok=False, error_type="network", message="t1")),
        notifier=hub,
    )
    run(sched.tick(T0))

    assert hub.pending() == []
    assert task_store.list_jobs(task.id)[0].status == "pending"  # 退避重试
