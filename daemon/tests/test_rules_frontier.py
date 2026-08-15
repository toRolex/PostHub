"""frontier 可领取谓词 / 排序键纯函数测试（ADR-0005 §rules frontier，#26）。

- eligible 谓词：定时到点 / 退避未到期 / 账号 active / 限速 / 同账号严格串行 +
  创建序排队，覆盖每个约束的布尔结果。
- frontier_sort_key：与 SQL `ORDER BY (publish_at IS NULL) DESC, publish_at ASC, id ASC`
  同语义（空 publish_at 在前，非空按时间升序，同值按 id 升序）。

只断言纯函数结果（不测 SQL / store 内部）；store 行为由 test_scheduler_store
参数化回归（本文件不重复 store 测试）。
"""

from __future__ import annotations

from types import SimpleNamespace

from posthub.accounts import Account
from posthub.rules import (
    frontier_sort_key,
    is_account_active,
    is_backoff_expired,
    is_job_eligible,
    is_rate_limited,
    is_serial_eligible,
    is_time_due,
)
from posthub.tasks import PlatformJob

T0 = "2026-08-08 00:00:00"


def make_job(status: str = "pending", **kw) -> PlatformJob:
    """一个 pending job，可按需覆盖排期 / 退避 / 账号 / id。"""
    base = dict(
        id=1,
        task_id=1,
        account_id=1,
        platform="douyin",
        status=status,
        schedule_policy=None,
        publish_mode=None,
        publish_at=None,
        retry_at=None,
        title=None,
        caption=None,
        tags=None,
        cover_horizontal=None,
        cover_vertical=None,
        platform_fields=None,
        post_id=None,
        post_url=None,
        attempt_count=0,
        last_error=None,
        last_error_type=None,
        locked_at=None,
        locked_by=None,
        created_at=T0,
        started_at=None,
        finished_at=None,
        updated_at=T0,
    )
    base.update(kw)
    return PlatformJob(**base)


def make_account(status: str = "active", last_publish_at: str | None = None) -> Account:
    """一个 active 账号，可按需覆盖状态 / 最近发布时间。"""
    return Account(
        id=1,
        platform="douyin",
        name="抖音一号",
        profile_dir="/tmp/p-dy",
        cdp_port=9222,
        chrome_path=None,
        status=status,
        last_login_at=None,
        last_publish_at=last_publish_at,
        created_at=T0,
        updated_at=T0,
    )


def make_task(publish_at: str | None = None) -> SimpleNamespace:
    """task 排期上下文（rules 只消费 task.publish_at 生效值，鸭子类型即可）。"""
    return SimpleNamespace(publish_at=publish_at, publish_mode="platform_time")


# ---- 定时到点 is_time_due ----

def test_time_due_immediate_when_no_publish_at() -> None:
    assert is_time_due(make_job(publish_at=None), make_task(), T0) is True


def test_time_due_true_when_publish_at_in_past() -> None:
    job = make_job(publish_at="2026-08-07 23:00:00")
    assert is_time_due(job, make_task(), T0) is True


def test_time_due_false_when_publish_at_in_future() -> None:
    job = make_job(publish_at="2026-08-08 01:00:00")
    assert is_time_due(job, make_task(), T0) is False


def test_time_due_inherits_task_publish_at() -> None:
    # job 排期字段为空 = 继承 task.publish_at
    job = make_job(publish_at=None)
    assert is_time_due(job, make_task(publish_at="2026-08-08 01:00:00"), T0) is False
    assert is_time_due(job, make_task(publish_at="2026-08-07 23:00:00"), T0) is True


# ---- 退避未到期 is_backoff_expired ----

def test_backoff_expired_when_no_retry_at() -> None:
    assert is_backoff_expired(make_job(retry_at=None), T0) is True


def test_backoff_expired_when_retry_at_in_past() -> None:
    assert is_backoff_expired(make_job(retry_at="2026-08-07 23:00:00"), T0) is True


def test_backoff_not_expired_when_retry_at_in_future() -> None:
    assert is_backoff_expired(make_job(retry_at="2026-08-08 00:00:30"), T0) is False


# ---- 账号 active is_account_active ----

def test_account_active_true() -> None:
    assert is_account_active(make_account()) is True


def test_account_active_false_when_missing() -> None:
    assert is_account_active(None) is False


def test_account_active_false_when_needs_relogin() -> None:
    assert is_account_active(make_account(status="needs_relogin")) is False


def test_account_active_false_when_disabled() -> None:
    assert is_account_active(make_account(status="disabled")) is False


# ---- 限速 is_rate_limited ----

def test_rate_limited_false_when_no_account() -> None:
    assert is_rate_limited(None, T0, 300) is False


def test_rate_limited_false_when_never_published() -> None:
    assert is_rate_limited(make_account(), T0, 300) is False


def test_rate_limited_true_inside_window() -> None:
    acc = make_account(last_publish_at="2026-08-08 00:01:00")
    assert is_rate_limited(acc, "2026-08-08 00:05:00", 300) is True


def test_rate_limited_false_at_boundary() -> None:
    # 恰好 300 秒：diff < rate_limit_seconds 为 False → 不限速
    acc = make_account(last_publish_at=T0)
    assert is_rate_limited(acc, "2026-08-08 00:05:00", 300) is False


# ---- 同账号严格串行 + 创建序 is_serial_eligible ----

def test_serial_eligible_min_pending_no_publishing() -> None:
    assert is_serial_eligible(make_job(id=3), set(), {1: 3}) is True


def test_serial_eligible_false_when_account_publishing() -> None:
    assert is_serial_eligible(make_job(id=3), {1}, {1: 3}) is False


def test_serial_eligible_false_when_not_min_pending() -> None:
    assert is_serial_eligible(make_job(id=5), set(), {1: 3}) is False


def test_serial_eligible_false_when_no_pending_min() -> None:
    assert is_serial_eligible(make_job(id=3), set(), {}) is False


# ---- 组合判定 is_job_eligible ----

def _eligible_ctx(**overrides) -> dict:
    ctx = dict(
        job=make_job(),
        task=make_task(),
        account=make_account(),
        now=T0,
        rate_limit_seconds=300,
        publishing_accounts=set(),
        pending_min={1: 1},
    )
    ctx.update(overrides)
    return ctx


def test_eligible_true_when_all_satisfied() -> None:
    assert is_job_eligible(**_eligible_ctx()) is True


def test_eligible_false_when_scheduled_not_due() -> None:
    ctx = _eligible_ctx(job=make_job(publish_at="2026-08-08 01:00:00"))
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_backoff_not_expired() -> None:
    ctx = _eligible_ctx(job=make_job(retry_at="2026-08-08 00:00:30"))
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_account_disabled() -> None:
    ctx = _eligible_ctx(account=make_account(status="disabled"))
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_account_missing() -> None:
    ctx = _eligible_ctx(account=None)
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_rate_limited() -> None:
    acc = make_account(last_publish_at="2026-08-08 00:01:00")
    ctx = _eligible_ctx(account=acc, now="2026-08-08 00:05:00")
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_account_has_publishing() -> None:
    ctx = _eligible_ctx(publishing_accounts={1})
    assert is_job_eligible(**ctx) is False


def test_eligible_false_when_not_min_pending() -> None:
    ctx = _eligible_ctx(job=make_job(id=5), pending_min={1: 3})
    assert is_job_eligible(**ctx) is False


# ---- 排序键 frontier_sort_key ----

def test_sort_key_immediate_no_publish_at() -> None:
    assert frontier_sort_key(make_job(id=2), make_task()) == (False, "", 2)


def test_sort_key_uses_effective_publish_at_from_task() -> None:
    # job 排期为空 = 继承 task.publish_at → 视为非空，参与时间排序
    job = make_job(id=1, publish_at=None)
    key = frontier_sort_key(job, make_task(publish_at="2026-08-08 01:00:00"))
    assert key == (True, "2026-08-08 01:00:00", 1)


def test_sort_key_none_publish_at_first_then_ascending() -> None:
    job_now = make_job(id=3, publish_at=None)
    job_early = make_job(id=1, publish_at="2026-08-08 01:00:00")
    job_late = make_job(id=2, publish_at="2026-08-08 02:00:00")
    jobs = [job_late, job_now, job_early]
    jobs.sort(key=lambda j: frontier_sort_key(j, make_task()))
    assert [j.id for j in jobs] == [3, 1, 2]


def test_sort_key_ties_by_id_ascending() -> None:
    a = make_job(id=2, publish_at="2026-08-08 01:00:00")
    b = make_job(id=1, publish_at="2026-08-08 01:00:00")
    jobs = [a, b]
    jobs.sort(key=lambda j: frontier_sort_key(j, make_task()))
    assert [j.id for j in jobs] == [1, 2]
