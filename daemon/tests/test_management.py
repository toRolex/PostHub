"""任务管理服务测试（#18 seam：list_tasks / get_task_detail / cancel_task / retry_job / list_logs）。

覆盖：
- list_tasks 按平台 / 状态 / 时间筛选 + 各 job 明细
- get_task_detail / get_job
- cancel_task：pending job → failed + user 日志；publishing 不可取消
- retry_job：终态 → pending + user 日志；非终态不可重试
- 日志写入与查询（level / task_id 筛选）；调度器状态变更写日志

InMemory / SQLite 参数化，与 #17 测试风格一致。
"""

from __future__ import annotations

import asyncio

import pytest

import posthub.tasks as tasks_module
from posthub.accounts import InMemoryAccountStore, NewAccount, SqliteAccountStore
from posthub.engine import UploadResult
from posthub.logs import LogFilters
from posthub.management import (
    JobNotFoundError,
    TaskManagementService,
    TaskNotFoundError,
)
from posthub.scheduler import Scheduler
from posthub.tasks import (
    InMemoryTaskStore,
    NewTaskSpec,
    PlatformJobSpec,
    SqliteTaskStore,
    TaskFilters,
)

T0 = "2026-08-08 00:00:00"


def run(coro):
    return asyncio.run(coro)


def make_accounts(store) -> None:
    store.create(
        NewAccount(platform="douyin", name="抖音一号", profile_dir="/tmp/p-dy", cdp_port=9222)
    )
    store.create(
        NewAccount(platform="xiaohongshu", name="小红书", profile_dir="/tmp/p-xhs", cdp_port=9223)
    )
    store.create(
        NewAccount(platform="wechat", name="视频号", profile_dir="/tmp/p-wx", cdp_port=9224)
    )


@pytest.fixture(params=["in-memory", "sqlite"])
def stores(tmp_path, request):
    if request.param == "in-memory":
        accounts = InMemoryAccountStore()
        task_store: InMemoryTaskStore | SqliteTaskStore = InMemoryTaskStore(accounts)
    else:
        accounts = SqliteAccountStore(tmp_path / "accounts.db")
        task_store = SqliteTaskStore(tmp_path / "tasks.db", accounts)
    make_accounts(accounts)
    yield task_store, accounts
    task_store.close()
    accounts.close()


class ScriptedExecutor:
    """fake 浏览器执行器：按序返回预设结果。"""

    def __init__(self, *script: UploadResult):
        self.script = list(script)
        self.index = 0

    async def upload(self, spec, context) -> UploadResult:
        if self.index < len(self.script):
            result = self.script[self.index]
            self.index += 1
            return result
        return UploadResult(ok=True)


def ok() -> UploadResult:
    return UploadResult(ok=True, post_id="p", post_url="https://e/p")


def make_spec(*, jobs, **kw) -> NewTaskSpec:
    base = dict(title="标题", video_path="/tmp/v.mp4", jobs=jobs)
    base.update(kw)
    return NewTaskSpec(**base)


def make_immediate(store, platform, account_id, title="标题"):
    return store.create_task(
        make_spec(title=title, jobs=[PlatformJobSpec(platform=platform, account_id=account_id)])
    )


# ---- list_tasks：列表 + 各 job 明细 + 筛选 ----

def test_list_tasks_returns_details_with_jobs(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    svc = TaskManagementService(task_store)
    details = svc.list_tasks()
    assert len(details) == 1
    assert details[0].task.id == task.id
    assert details[0].task.title == "A"
    assert len(details[0].jobs) == 1
    assert details[0].jobs[0].id == jobs[0].id
    assert details[0].jobs[0].platform == "douyin"


def test_list_tasks_filter_by_platform(stores) -> None:
    task_store, _ = stores
    make_immediate(task_store, "douyin", 1, title="A")
    make_immediate(task_store, "xiaohongshu", 2, title="B")
    svc = TaskManagementService(task_store)
    details = svc.list_tasks(TaskFilters(platform="douyin"))
    assert [d.task.title for d in details] == ["A"]
    assert svc.list_tasks(TaskFilters(platform="wechat")) == []


def test_list_tasks_filter_by_status(stores) -> None:
    task_store, _ = stores
    make_immediate(task_store, "douyin", 1, title="A")  # pending
    _, jobs_b = make_immediate(task_store, "xiaohongshu", 2, title="B")
    task_store.apply_terminal(jobs_b[0].id, T0, "failed", "拒", "platform_reject")
    svc = TaskManagementService(task_store)
    assert [d.task.title for d in svc.list_tasks(TaskFilters(status="pending"))] == ["A"]
    assert [d.task.title for d in svc.list_tasks(TaskFilters(status="failed"))] == ["B"]


def test_list_tasks_filter_by_time_range(stores, monkeypatch) -> None:
    task_store, _ = stores
    monkeypatch.setattr(tasks_module, "now_str", lambda: "2026-08-01 10:00:00")
    make_immediate(task_store, "douyin", 1, title="A")
    monkeypatch.setattr(tasks_module, "now_str", lambda: "2026-08-03 10:00:00")
    make_immediate(task_store, "xiaohongshu", 2, title="B")
    svc = TaskManagementService(task_store)
    only_a = svc.list_tasks(TaskFilters(from_ts="2026-08-01 00:00:00", to_ts="2026-08-02 00:00:00"))
    assert [d.task.title for d in only_a] == ["A"]
    only_b = svc.list_tasks(TaskFilters(from_ts="2026-08-03 00:00:00"))
    assert [d.task.title for d in only_b] == ["B"]


def test_list_tasks_orders_newest_first(stores) -> None:
    task_store, _ = stores
    make_immediate(task_store, "douyin", 1, title="A")
    make_immediate(task_store, "xiaohongshu", 2, title="B")
    svc = TaskManagementService(task_store)
    assert [d.task.title for d in svc.list_tasks()] == ["B", "A"]


# ---- get_task_detail / get_job ----

def test_get_task_detail(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    svc = TaskManagementService(task_store)
    detail = svc.get_task_detail(task.id)
    assert detail is not None
    assert detail.task.title == "A"
    assert detail.jobs[0].id == jobs[0].id
    assert svc.get_task_detail(9999) is None


def test_get_job(stores) -> None:
    task_store, _ = stores
    _, jobs = make_immediate(task_store, "douyin", 1, title="A")
    job = task_store.get_job(jobs[0].id)
    assert job is not None
    assert job.platform == "douyin"
    assert task_store.get_job(9999) is None


# ---- cancel_task：pending → failed + user 日志 ----

def test_cancel_task_pending_jobs_to_failed(stores) -> None:
    task_store, _ = stores
    task, jobs = task_store.create_task(
        make_spec(
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
            ]
        )
    )
    svc = TaskManagementService(task_store)
    canceled = svc.cancel_task(task.id, T0)
    assert len(canceled) == 2
    assert all(j.status == "failed" for j in canceled)
    assert all(j.last_error == "任务已取消" for j in canceled)
    assert task_store.get_task(task.id).status == "failed"
    logs = task_store.list_logs(LogFilters(task_id=task.id))
    assert any(l.source == "user" and "取消" in l.message for l in logs)


def test_cancel_task_only_pending_jobs(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    task_store.apply_success(jobs[0].id, T0)
    svc = TaskManagementService(task_store)
    canceled = svc.cancel_task(task.id, T0)
    assert canceled == []
    assert task_store.get_task(task.id).status == "success"  # 不改变非 pending
    logs = task_store.list_logs(LogFilters(task_id=task.id))
    assert any(l.source == "user" and "取消" in l.message for l in logs)


def test_cancel_task_unknown_raises(stores) -> None:
    task_store, _ = stores
    svc = TaskManagementService(task_store)
    with pytest.raises(TaskNotFoundError):
        svc.cancel_task(999, T0)


# ---- retry_job：终态 → pending + user 日志 ----

def test_retry_job_terminal_to_pending(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    job_id = jobs[0].id
    claimed = task_store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert claimed[0].attempt_count == 1
    task_store.apply_terminal(job_id, T0, "failed", "风控", "risk_control")
    svc = TaskManagementService(task_store)
    updated = svc.retry_job(job_id, T0)
    assert updated is not None
    assert updated.status == "pending"
    assert updated.attempt_count == 1  # 重试次数保留
    logs = task_store.list_logs(LogFilters(task_id=task.id))
    assert any(l.source == "user" and "重试" in l.message for l in logs)


def test_retry_job_not_terminal_returns_none(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    svc = TaskManagementService(task_store)
    assert svc.retry_job(jobs[0].id, T0) is None  # pending 不可重试


def test_retry_job_unknown_raises(stores) -> None:
    task_store, _ = stores
    svc = TaskManagementService(task_store)
    with pytest.raises(JobNotFoundError):
        svc.retry_job(999, T0)


# ---- 日志写入与查询 ----

def test_add_and_list_logs(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1, title="A")
    task_store.add_log("info", "user", "hello", task_id=task.id, job_id=jobs[0].id)
    task_store.add_log("error", "scheduler", "boom", task_id=task.id)
    logs = task_store.list_logs()
    assert len(logs) == 2
    assert logs[0].message == "boom"  # 倒序（新在前）
    assert logs[0].level == "error"
    assert logs[0].source == "scheduler"
    assert [l.message for l in task_store.list_logs(LogFilters(level="info"))] == ["hello"]
    assert len(task_store.list_logs(LogFilters(task_id=task.id))) == 2
    assert task_store.list_logs(LogFilters(task_id=999)) == []


def test_list_logs_respects_limit(stores) -> None:
    task_store, _ = stores
    task, _ = make_immediate(task_store, "douyin", 1, title="A")
    for i in range(5):
        task_store.add_log("info", "user", f"m{i}", task_id=task.id)
    logs = task_store.list_logs(LogFilters(limit=3))
    assert [l.message for l in logs] == ["m4", "m3", "m2"]


def test_scheduler_writes_logs_on_transitions(stores) -> None:
    task_store, accounts = stores
    task, _ = make_immediate(task_store, "douyin", 1, title="A")
    fake = ScriptedExecutor(ok())
    run(Scheduler(task_store, accounts, fake).tick(T0))
    logs = task_store.list_logs(LogFilters(task_id=task.id))
    assert any("成功" in l.message for l in logs)
