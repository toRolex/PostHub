"""调度器 tick 测试（ADR-0001 §调度 / 重试 / 限速 接口 + 唯一 seam）。

唯一 seam：`Scheduler.tick(now)` → 领取并执行一批 + 持久化状态机迁移。
测试只断言 seam 外部行为：`create_task` 落库的 task/job + fake 执行器 → job_updates 与
task/job/account 最终状态。InMemory / SQLite 参数化。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount, SqliteAccountStore
from posthub.engine import UploadResult
from posthub.scheduler import Scheduler
from posthub.tasks import (
    InMemoryTaskStore,
    NewTaskSpec,
    PlatformJobSpec,
    SqliteTaskStore,
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
    """fake 浏览器执行器：按序返回预设结果，记录 (spec, context)，检测最大并发。"""

    def __init__(self, *script: UploadResult, delay: float = 0.0):
        self.script = list(script)
        self.delay = delay
        self.calls: list = []
        self.index = 0
        self.active = 0
        self.max_active = 0

    async def upload(self, spec, context) -> UploadResult:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        if self.delay:
            await asyncio.sleep(self.delay)
        self.calls.append((spec, context))
        self.active -= 1
        if self.index < len(self.script):
            result = self.script[self.index]
            self.index += 1
            return result
        return UploadResult(ok=True)


def ok(post_id: str | None = None) -> UploadResult:
    return UploadResult(ok=True, post_id=post_id or "p", post_url="https://e/p")


def make_spec(*, jobs, **kw) -> NewTaskSpec:
    base = dict(title="标题", video_path="/tmp/v.mp4", jobs=jobs)
    base.update(kw)
    return NewTaskSpec(**base)


def make_immediate(store, platform, account_id, title="标题"):
    return store.create_task(
        make_spec(title=title, jobs=[PlatformJobSpec(platform=platform, account_id=account_id)])
    )


def future_at(days: int = 3) -> str:
    return (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def make_scheduler(stores, executor, **kw) -> Scheduler:
    task_store, account_store = stores
    return Scheduler(task_store, account_store, executor, **kw)


# ---- 成功发布全链路 ----

def test_tick_success_all_platforms(stores) -> None:
    task_store, accounts = stores
    task, jobs = task_store.create_task(
        make_spec(
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
                PlatformJobSpec(platform="wechat", account_id=3),
            ]
        )
    )
    fake = ScriptedExecutor(ok(), ok(), ok())
    sched = make_scheduler(stores, fake)
    updates = run(sched.tick(T0))

    # fake 执行器被调用 3 次（每平台一次），且收到正确的 task_spec
    assert len(fake.calls) == 3
    assert {c[0].platform for c in fake.calls} == {"douyin", "xiaohongshu", "wechat"}
    assert all(c[0].task_id == str(task.id) for c in fake.calls)

    # 每个 job → success，task 聚合 success，账号 last_publish_at 回写
    got = task_store.list_jobs(task.id)
    assert all(j.status == "success" for j in got)
    assert task_store.get_task(task.id).status == "success"
    assert all(a.last_publish_at == T0 for a in accounts.list())

    # job_updates 流：每 job 一条 publishing + 一条 success
    statuses = [u.status for u in updates]
    assert statuses.count("publishing") == 3
    assert statuses.count("success") == 3


# ---- 同平台串行 + 限速 5 分钟 ----

def test_tick_same_account_serial_with_rate_limit(stores) -> None:
    task_store, accounts = stores
    _, jobs_a = make_immediate(task_store, "douyin", 1, title="A")
    _, jobs_b = make_immediate(task_store, "douyin", 1, title="B")
    fake = ScriptedExecutor(ok())
    sched = make_scheduler(stores, fake)

    # tick 1：同账号串行 + 限速 → 只发 A
    run(sched.tick(T0))
    assert len(fake.calls) == 1
    assert fake.calls[0][0].title == "A"
    assert task_store.list_jobs(jobs_a[0].task_id)[0].status == "success"
    assert task_store.list_jobs(jobs_b[0].task_id)[0].status == "pending"

    # tick 2：4 分钟后仍限速 → B 不动
    fake2 = ScriptedExecutor(ok())
    sched2 = make_scheduler(stores, fake2)
    run(sched2.tick("2026-08-08 00:04:00"))
    assert fake2.calls == []
    assert task_store.list_jobs(jobs_b[0].task_id)[0].status == "pending"

    # tick 3：满 5 分钟 → B 放行（串行顺序：A 先 B 后）
    fake3 = ScriptedExecutor(ok())
    sched3 = make_scheduler(stores, fake3)
    run(sched3.tick("2026-08-08 00:05:00"))
    assert len(fake3.calls) == 1
    assert fake3.calls[0][0].title == "B"
    assert task_store.list_jobs(jobs_b[0].task_id)[0].status == "success"


# ---- 跨平台并行 2-3 ----

def test_tick_cross_platform_parallel(stores) -> None:
    task_store, _ = stores
    make_immediate(task_store, "douyin", 1)
    make_immediate(task_store, "xiaohongshu", 2)
    make_immediate(task_store, "wechat", 3)
    fake = ScriptedExecutor(ok(), ok(), ok(), delay=0.05)
    sched = make_scheduler(stores, fake, concurrency=3)

    run(sched.tick(T0))
    # 3 路并行：同一时刻最多 3 个上传在飞
    assert fake.max_active == 3
    assert len(fake.calls) == 3


def test_tick_concurrency_capped(stores) -> None:
    task_store, _ = stores
    make_immediate(task_store, "douyin", 1)
    make_immediate(task_store, "xiaohongshu", 2)
    make_immediate(task_store, "wechat", 3)
    fake = ScriptedExecutor(ok(), ok(), ok(), delay=0.05)
    sched = make_scheduler(stores, fake, concurrency=2)

    run(sched.tick(T0))
    # 并发上限 2：批次先并发 2 个，再补 1 个；同平台无重叠
    assert fake.max_active == 2
    assert len(fake.calls) == 3


# ---- 网络类重试 2 次退避 ----

def test_network_retry_backoff_then_success(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    job_id = jobs[0].id
    fake = ScriptedExecutor(
        UploadResult(ok=False, error_type="network", message="t1"),
        UploadResult(ok=False, error_type="network", message="t2"),
        ok(),
    )
    sched = make_scheduler(stores, fake)

    # 第 1 次失败 → 退避 30s 回 pending
    updates = run(sched.tick(T0))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "pending"
    assert j.attempt_count == 1
    assert j.retry_at == "2026-08-08 00:00:30"
    assert j.last_error_type == "network"
    # job_updates 流：publishing → pending（网络重试），携带 error_type
    assert [u.status for u in updates] == ["publishing", "pending"]
    assert updates[-1].error_type == "network"
    assert updates[-1].attempt_count == 1

    # 第 2 次失败 → 退避 2min 回 pending
    run(sched.tick("2026-08-08 00:00:30"))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "pending"
    assert j.attempt_count == 2
    assert j.retry_at == "2026-08-08 00:02:30"

    # 第 3 次成功 → success
    run(sched.tick("2026-08-08 00:02:30"))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "success"
    assert j.attempt_count == 3
    assert j.post_id == "p"


def test_network_retry_exhausts_to_failed(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    job_id = jobs[0].id
    fake = ScriptedExecutor(
        UploadResult(ok=False, error_type="network", message="t1"),
        UploadResult(ok=False, error_type="network", message="t2"),
        UploadResult(ok=False, error_type="network", message="t3"),
    )
    sched = make_scheduler(stores, fake)

    run(sched.tick(T0))
    run(sched.tick("2026-08-08 00:00:30"))
    run(sched.tick("2026-08-08 00:02:30"))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "failed"
    assert j.attempt_count == 3
    assert j.last_error_type == "network"
    assert task_store.get_task(task.id).status == "failed"


# ---- 风控 / auth / 平台拒绝 ----

def test_risk_control_to_manual(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    fake = ScriptedExecutor(UploadResult(ok=False, error_type="risk_control", message="风控"))
    sched = make_scheduler(stores, fake)
    updates = run(sched.tick(T0))

    j = task_store.list_jobs(task.id)[0]
    assert j.status == "manual"
    assert task_store.get_task(task.id).status == "manual"
    assert len(fake.calls) == 1  # 风控不自动重试
    assert updates[-1].status == "manual"


def test_auth_to_needs_relogin_sets_account(stores) -> None:
    task_store, accounts = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    fake = ScriptedExecutor(UploadResult(ok=False, error_type="auth", message="登录失效"))
    sched = make_scheduler(stores, fake)
    run(sched.tick(T0))

    j = task_store.list_jobs(task.id)[0]
    assert j.status == "needs_relogin"
    assert accounts.get(1).status == "needs_relogin"
    assert task_store.get_task(task.id).status == "needs_relogin"


def test_platform_reject_to_failed(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    fake = ScriptedExecutor(UploadResult(ok=False, error_type="platform_reject", message="拒"))
    sched = make_scheduler(stores, fake)
    run(sched.tick(T0))
    assert task_store.list_jobs(task.id)[0].status == "failed"
    assert task_store.get_task(task.id).status == "failed"


# ---- 定时到点执行 / 错过窗口 ----

def test_scheduled_local_time_runs_at_due(stores) -> None:
    task_store, _ = stores
    publish_at = future_at(3)
    task, jobs = task_store.create_task(
        make_spec(
            title="定时",
            schedule_policy="scheduled",
            publish_mode="local_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    fake = ScriptedExecutor(ok())
    sched = make_scheduler(stores, fake)

    # 未到点：不领取、不执行
    before = (datetime.strptime(publish_at, "%Y-%m-%d %H:%M:%S") - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
    run(sched.tick(before))
    assert fake.calls == []
    assert task_store.list_jobs(task.id)[0].status == "pending"

    # 到点：自动执行，fake 收到生效的 local_time 排期
    run(sched.tick(publish_at))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "success"
    assert len(fake.calls) == 1
    spec = fake.calls[0][0]
    assert spec.publish_mode == "local_time"
    assert spec.publish_at == publish_at


def test_scheduled_missed_past_tolerance(stores) -> None:
    task_store, _ = stores
    publish_at = future_at(3)
    task, jobs = task_store.create_task(
        make_spec(
            title="定时",
            schedule_policy="scheduled",
            publish_mode="local_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    fake = ScriptedExecutor(ok())
    sched = make_scheduler(stores, fake)

    late = (datetime.strptime(publish_at, "%Y-%m-%d %H:%M:%S") + timedelta(minutes=11)).strftime("%Y-%m-%d %H:%M:%S")
    updates = run(sched.tick(late))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "missed"
    assert task_store.get_task(task.id).status == "missed"
    assert fake.calls == []  # 错过窗口不再执行
    assert updates[-1].status == "missed"


def test_stale_publishing_timeout_missed(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    # 手动领取使其进入 publishing（模拟卡死）
    claimed = task_store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(claimed) == 1
    fake = ScriptedExecutor(ok())
    sched = make_scheduler(stores, fake)

    # 31 分钟无心跳 → 兜底 missed
    run(sched.tick("2026-08-08 00:31:00"))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "missed"
    assert task_store.get_task(task.id).status == "missed"
    assert fake.calls == []


# ---- task 聚合 partial ----

def test_tick_partial_task_aggregate(stores) -> None:
    task_store, _ = stores
    task, jobs = task_store.create_task(
        make_spec(
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
                PlatformJobSpec(platform="wechat", account_id=3),
            ]
        )
    )
    fake = ScriptedExecutor(
        ok(),
        ok(),
        UploadResult(ok=False, error_type="platform_reject", message="拒"),
    )
    sched = make_scheduler(stores, fake)
    run(sched.tick(T0))
    got = task_store.list_jobs(task.id)
    by_platform = {j.platform: j.status for j in got}
    assert by_platform["douyin"] == "success"
    assert by_platform["xiaohongshu"] == "success"
    assert by_platform["wechat"] == "failed"
    assert task_store.get_task(task.id).status == "partial"


# ---- 手动重试（终态 → pending，次数保留）----

def test_manual_retry_then_success(stores) -> None:
    task_store, _ = stores
    task, jobs = make_immediate(task_store, "douyin", 1)
    job_id = jobs[0].id
    fake = ScriptedExecutor(UploadResult(ok=False, error_type="risk_control"))
    sched = make_scheduler(stores, fake)
    run(sched.tick(T0))
    assert task_store.list_jobs(task.id)[0].status == "manual"

    # 用户手动重试 → pending（重试次数保留）
    ok_retry = sched.retry_job(job_id, T0)
    assert ok_retry is True
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "pending"
    assert j.attempt_count == 1

    # 再调度 → 成功；attempt_count 保留并累加
    fake2 = ScriptedExecutor(ok())
    sched2 = make_scheduler(stores, fake2)
    run(sched2.tick(T0))
    j = task_store.list_jobs(task.id)[0]
    assert j.status == "success"
    assert j.attempt_count == 2


# ---- SQLite 状态机持久化（重启可查）----

def test_sqlite_persists_after_reopen(tmp_path) -> None:
    accounts = SqliteAccountStore(tmp_path / "accounts.db")
    make_accounts(accounts)
    db = tmp_path / "tasks.db"
    task_store = SqliteTaskStore(db, accounts)
    task, jobs = task_store.create_task(
        make_spec(
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
            ]
        )
    )
    fake = ScriptedExecutor(ok(), ok())
    run(make_scheduler((task_store, accounts), fake).tick(T0))
    # 崩溃/重启前状态
    assert task_store.list_jobs(task.id)[0].status == "success"
    assert accounts.get(1).last_publish_at == T0
    task_store.close()

    # 重启后状态可查
    task_store2 = SqliteTaskStore(db, accounts)
    try:
        got = task_store2.list_jobs(task.id)
        assert all(j.status == "success" for j in got)
        assert task_store2.get_task(task.id).status == "success"
        assert accounts.get(1).last_publish_at == T0
        assert accounts.get(2).last_publish_at == T0
    finally:
        task_store2.close()
        accounts.close()
