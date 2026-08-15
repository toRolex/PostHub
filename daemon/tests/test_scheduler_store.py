"""调度器 store 原语测试（ADR-0001 §调度 / 重试 / 限速 接口）。

覆盖 TaskStore 扩展方法（InMemory / SQLite 可互换）：
- claim_eligible_jobs：frontier 查询 + 乐观锁领取（同账号串行、跨平台并发上限、限速、active）
- apply_success / apply_terminal / requeue / mark_missed / retry_job：状态迁移 + task 聚合回写
- list_pending_missed / list_stale_publishing：missed 判定扫描
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount, SqliteAccountStore
from posthub.state import add_seconds
from posthub.tasks import (
    InMemoryTaskStore,
    NewTaskSpec,
    PlatformJobSpec,
    SqliteTaskStore,
)

T0 = "2026-08-08 00:00:00"


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


def make_spec(*, jobs, **kw) -> NewTaskSpec:
    base = dict(title="标题", video_path="/tmp/v.mp4", jobs=jobs)
    base.update(kw)
    return NewTaskSpec(**base)


def make_immediate(store, platform, account_id, title="标题") -> tuple:
    return store.create_task(
        make_spec(title=title, jobs=[PlatformJobSpec(platform=platform, account_id=account_id)])
    )


def future_at(days: int = 3) -> str:
    return (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


# ---- claim_eligible_jobs ----

def test_claim_immediate_job(stores) -> None:
    store, _ = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert [j.id for j in claimed] == [jobs[0].id]
    c = claimed[0]
    assert c.status == "publishing"
    assert c.attempt_count == 1
    assert c.locked_by == "s1"
    assert c.locked_at == T0
    assert c.started_at == T0
    assert c.updated_at == T0


def test_claim_second_call_returns_empty_optimistic_lock(stores) -> None:
    store, _ = stores
    make_immediate(store, "douyin", 1)
    first = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(first) == 1
    # 乐观锁：同一 job 已被领取为 publishing，再次领取不得重复返回
    second = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert second == []


def test_claim_same_account_serial_only_min_pending(stores) -> None:
    store, _ = stores
    _, jobs_a = make_immediate(store, "douyin", 1, title="任务A")
    _, jobs_b = make_immediate(store, "douyin", 1, title="任务B")
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    # 同账号同平台严格串行：只取创建序最早的一个（任务A 的 job）
    assert [j.id for j in claimed] == [jobs_a[0].id]
    assert jobs_b[0].id != jobs_a[0].id


def test_claim_serial_blocks_second_while_publishing(stores) -> None:
    store, _ = stores
    _, jobs_a = make_immediate(store, "douyin", 1, title="A")
    make_immediate(store, "douyin", 1, title="B")
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert [j.id for j in claimed] == [jobs_a[0].id]
    # 任务A 仍 publishing → 同账号第二 job 不可领取（严格串行）
    again = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert again == []


def test_claim_cross_platform_concurrency_limit(stores) -> None:
    store, _ = stores
    make_immediate(store, "douyin", 1)
    make_immediate(store, "xiaohongshu", 2)
    make_immediate(store, "wechat", 3)
    claimed = store.claim_eligible_jobs(T0, limit=2, scheduler_id="s1")
    assert len(claimed) == 2  # 跨平台并行上限 = concurrency
    # 未超过并发上限时，其余平台 job 仍可领取
    rest = store.claim_eligible_jobs(T0, limit=2, scheduler_id="s1")
    assert len(rest) == 1


def test_claim_rate_limit_blocks_same_account(stores) -> None:
    store, accounts = stores
    _, jobs_a = make_immediate(store, "douyin", 1, title="A")
    _, jobs_b = make_immediate(store, "douyin", 1, title="B")
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(claimed) == 1
    store.apply_success(claimed[0].id, T0, post_id="p1")
    # 刚发布完成：距 last_publish_at=0s < 300s → 同账号下一 job 被限速
    assert store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1") == []
    # 4 分钟后仍不足 5 分钟
    t4 = add_seconds(T0, 240)
    assert store.claim_eligible_jobs(t4, limit=3, scheduler_id="s1") == []
    # 5 分钟后放行（同账号串行按创建序：任务 B 的 job）
    t5 = add_seconds(T0, 300)
    claimed2 = store.claim_eligible_jobs(t5, limit=3, scheduler_id="s1")
    assert [j.id for j in claimed2] == [jobs_b[0].id]


def test_claim_skips_disabled_account(stores) -> None:
    store, accounts = stores
    accounts.set_status(2, "disabled")
    make_immediate(store, "xiaohongshu", 2)
    assert store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1") == []


def test_claim_skips_scheduled_not_due(stores) -> None:
    store, _ = stores
    publish_at = future_at(3)
    store.create_task(
        make_spec(
            title="定时",
            schedule_policy="scheduled",
            publish_mode="local_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    # 未到点：不领取
    assert store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1") == []
    # 到点后领取（publish_at 用 job 生效值 = task）
    at_due = add_seconds(publish_at, 1)
    claimed = store.claim_eligible_jobs(at_due, limit=3, scheduler_id="s1")
    assert len(claimed) == 1


def test_claim_respects_retry_at_backoff(stores) -> None:
    store, _ = stores
    _, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(claimed) == 1
    job = claimed[0]
    # 网络类失败 → 退避退到 pending（retry_at = 未来）
    store.requeue(job.id, T0, retry_at=add_seconds(T0, 30), message="timeout", error_type="network")
    assert store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1") == []
    # 退避期过 → 可领取
    after = add_seconds(T0, 31)
    re = store.claim_eligible_jobs(after, limit=3, scheduler_id="s1")
    assert len(re) == 1
    assert re[0].attempt_count == 2  # 重试次数累加


def test_claim_oldest_pending_scheduled_blocks_newer_due(stores) -> None:
    """创建序排队：最早 pending 的定时 job 未到点，后创建的立即 job 也被挡住。

    钉住 #26 收敛的 pending_min 派生语义：每账号 pending 最小 id 对「全部 pending」
    计算（含定时未到点 / 退避中的 job），而非仅定时 / 退避已通过的候选。
    """
    store, _ = stores
    publish_at = future_at(3)
    _, jobs_a = store.create_task(
        make_spec(
            title="定时A",
            schedule_policy="scheduled",
            publish_mode="local_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    _, jobs_b = make_immediate(store, "douyin", 1, title="立即B")
    assert jobs_a[0].id < jobs_b[0].id  # A 先创建 = 最早 pending
    # A 定时未到点：最早 pending 的 A 挡住后创建的立即 B（创建序排队，不被跳过）
    assert store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1") == []
    # A 到点后：按创建序先领 A
    at_due = add_seconds(publish_at, 1)
    claimed = store.claim_eligible_jobs(at_due, limit=3, scheduler_id="s1")
    assert [j.id for j in claimed] == [jobs_a[0].id]


# ---- 状态迁移 + task 聚合回写 ----

def test_apply_success_updates_job_account_task(stores) -> None:
    store, accounts = stores
    make_immediate(store, "douyin", 1)
    make_immediate(store, "xiaohongshu", 2)
    make_immediate(store, "wechat", 3)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(claimed) == 3
    for job in claimed:
        store.apply_success(job.id, T0, post_id=f"p{job.id}", post_url=f"url/{job.id}")
    # 每个 job success；账号 last_publish_at 回写；task 聚合 success
    for job in claimed:
        got = store.list_jobs(job.task_id)
        j = next(x for x in got if x.id == job.id)
        assert j.status == "success"
        assert j.post_id == f"p{job.id}"
        acc = accounts.get(job.account_id)
        assert acc.last_publish_at == T0
    for job in claimed:
        assert store.get_task(job.task_id).status == "success"


def test_apply_terminal_needs_relogin_sets_account(stores) -> None:
    store, accounts = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    store.apply_terminal(claimed[0].id, T0, "needs_relogin", message="登录失效", error_type="auth")
    got = store.list_jobs(task.id)
    assert got[0].status == "needs_relogin"
    assert got[0].last_error_type == "auth"
    assert accounts.get(1).status == "needs_relogin"
    assert store.get_task(task.id).status == "needs_relogin"


def test_apply_terminal_manual_risk_control(stores) -> None:
    store, accounts = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    store.apply_terminal(claimed[0].id, T0, "manual", message="风控", error_type="risk_control")
    assert store.list_jobs(task.id)[0].status == "manual"
    assert store.get_task(task.id).status == "manual"


def test_requeue_returns_pending_with_retry_at(stores) -> None:
    store, _ = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    store.requeue(claimed[0].id, T0, retry_at=add_seconds(T0, 30), message="timeout", error_type="network")
    got = store.list_jobs(task.id)[0]
    assert got.status == "pending"
    assert got.retry_at == add_seconds(T0, 30)
    assert got.last_error_type == "network"
    assert got.attempt_count == 1  # 领取时的累加保留
    assert store.get_task(task.id).status == "pending"


def test_mark_missed_sets_task_missed(stores) -> None:
    store, _ = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    store.mark_missed(claimed[0].id, T0)
    assert store.list_jobs(task.id)[0].status == "missed"
    assert store.get_task(task.id).status == "missed"


def test_retry_job_preserves_attempt_count(stores) -> None:
    store, _ = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    store.apply_terminal(claimed[0].id, T0, "failed", message="网络", error_type="network")
    assert store.list_jobs(task.id)[0].status == "failed"
    ok = store.retry_job(claimed[0].id, add_seconds(T0, 60))
    assert ok is True
    got = store.list_jobs(task.id)[0]
    assert got.status == "pending"
    assert got.attempt_count == 1  # 重试次数保留
    assert store.get_task(task.id).status == "pending"
    # 再领取 → attempt_count 2
    re = store.claim_eligible_jobs(add_seconds(T0, 60), limit=3, scheduler_id="s1")
    assert re[0].attempt_count == 2


def test_partial_task_when_success_and_failed(stores) -> None:
    store, accounts = stores
    # 同 task 两个平台：douyin 成功、xiaohongshu 失败 → partial
    new = make_spec(
        jobs=[
            PlatformJobSpec(platform="douyin", account_id=1),
            PlatformJobSpec(platform="xiaohongshu", account_id=2),
        ]
    )
    task, jobs = store.create_task(new)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    dy = next(j for j in claimed if j.platform == "douyin")
    xhs = next(j for j in claimed if j.platform == "xiaohongshu")
    store.apply_success(dy.id, T0, post_id="p-dy")
    store.apply_terminal(xhs.id, T0, "failed", message="拒绝", error_type="platform_reject")
    assert store.get_task(task.id).status == "partial"


# ---- missed 判定扫描 ----

def test_list_pending_missed_local_time_past_tolerance(stores) -> None:
    store, _ = stores
    publish_at = future_at(3)
    task, jobs = store.create_task(
        make_spec(
            title="定时",
            schedule_policy="scheduled",
            publish_mode="local_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    # 容忍窗口内（+5 分钟）：不算 missed
    inside = add_seconds(publish_at, 5 * 60)
    assert store.list_pending_missed(inside, tolerance_seconds=600) == []
    # 超过容忍窗口（+11 分钟）：标记候选
    outside = add_seconds(publish_at, 11 * 60)
    hit = store.list_pending_missed(outside, tolerance_seconds=600)
    assert [j.id for j in hit] == [jobs[0].id]


def test_list_pending_missed_ignores_immediate_and_platform_time(stores) -> None:
    store, _ = stores
    make_immediate(store, "douyin", 1)
    publish_at = future_at(3)
    store.create_task(
        make_spec(
            title="平台定时",
            schedule_policy="scheduled",
            publish_mode="platform_time",
            publish_at=publish_at,
            jobs=[PlatformJobSpec(platform="xiaohongshu", account_id=2)],
        )
    )
    outside = add_seconds(publish_at, 11 * 60)
    assert store.list_pending_missed(outside, tolerance_seconds=600) == []


def test_list_stale_publishing_timeout(stores) -> None:
    store, _ = stores
    task, jobs = make_immediate(store, "douyin", 1)
    claimed = store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    assert len(claimed) == 1
    # 29 分钟：未超时
    assert store.list_stale_publishing(add_seconds(T0, 29 * 60), timeout_seconds=1800) == []
    # 31 分钟：超时 → 兜底 missed
    stale = store.list_stale_publishing(add_seconds(T0, 31 * 60), timeout_seconds=1800)
    assert [j.id for j in stale] == [claimed[0].id]
