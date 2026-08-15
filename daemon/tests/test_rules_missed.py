"""missed 判定谓词纯函数测试（ADR-0005 §rules missed，#27）。

- `is_pending_missed(job, task, now, tolerance_seconds)`：pending-missed 判定——
  local_time 定时超容忍窗口（生效 publish_mode 为 local_time、生效 publish_at
  非空且 <= now - tolerance_seconds）。
- `is_stale_publishing(job, now, timeout_seconds)`：stale-publishing 判定——
  publishing 按 updated_at 超时（job 为 publishing 且 updated_at <= now - timeout_seconds）。

只断言纯函数结果（不测 SQL / store 内部）；store 行为由 test_scheduler_store
参数化回归（本文件不重复 store 测试）。
"""

from __future__ import annotations

from types import SimpleNamespace

from posthub.rules import is_pending_missed, is_stale_publishing
from posthub.tasks import PlatformJob

T0 = "2026-08-08 00:00:00"


def make_job(status: str = "pending", **kw) -> PlatformJob:
    """一个 pending job，可按需覆盖状态 / 排期 / updated_at。"""
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


def make_task(publish_mode: str = "local_time", publish_at: str | None = None) -> SimpleNamespace:
    """task 排期上下文（rules 只消费生效 publish_mode / publish_at，鸭子类型即可）。"""
    return SimpleNamespace(publish_mode=publish_mode, publish_at=publish_at)


# ---- pending-missed 谓词（local_time 定时超容忍窗口）----

def test_pending_missed_true_when_local_time_past_tolerance() -> None:
    # publish_at 23:00，now=00:00，容忍 10min → cutoff 23:50；23:00 <= 23:50
    job = make_job(publish_mode="local_time", publish_at="2026-08-07 23:00:00")
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is True


def test_pending_missed_true_at_tolerance_boundary() -> None:
    # publish_at 恰好 cutoff（23:50）：`<=` 含边界 → missed
    job = make_job(publish_mode="local_time", publish_at="2026-08-07 23:50:00")
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is True


def test_pending_missed_false_when_within_tolerance() -> None:
    # publish_at 23:55 > cutoff 23:50 → 未超容忍窗口
    job = make_job(publish_mode="local_time", publish_at="2026-08-07 23:55:00")
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is False


def test_pending_missed_false_when_platform_time() -> None:
    job = make_job(publish_mode="platform_time", publish_at="2026-08-07 23:00:00")
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is False


def test_pending_missed_false_when_immediate_no_publish_at() -> None:
    # publish_at 空 = 立即发布，无定时窗口可言 → 不判 missed
    job = make_job(publish_at=None)
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is False


def test_pending_missed_false_when_not_pending() -> None:
    job = make_job(status="publishing", publish_mode="local_time",
                   publish_at="2026-08-07 23:00:00")
    assert is_pending_missed(job, make_task(), T0, tolerance_seconds=600) is False


def test_pending_missed_inherits_task_publish_mode_and_at() -> None:
    # job 排期字段为空 = 继承 task 生效值
    job = make_job(publish_mode=None, publish_at=None)
    assert is_pending_missed(
        job, make_task(publish_mode="local_time", publish_at="2026-08-07 23:00:00"),
        T0, tolerance_seconds=600,
    ) is True
    assert is_pending_missed(
        job, make_task(publish_mode="platform_time", publish_at="2026-08-07 23:00:00"),
        T0, tolerance_seconds=600,
    ) is False


# ---- stale-publishing 谓词（publishing 按 updated_at 超时）----

def test_stale_publishing_true_when_updated_at_past_timeout() -> None:
    # updated_at 23:00，now=00:00，超时 30min → cutoff 23:30；23:00 <= 23:30
    job = make_job(status="publishing", updated_at="2026-08-07 23:00:00")
    assert is_stale_publishing(job, T0, timeout_seconds=1800) is True


def test_stale_publishing_true_at_timeout_boundary() -> None:
    # updated_at 恰好 cutoff（23:30）：`<=` 含边界 → 超时
    job = make_job(status="publishing", updated_at="2026-08-07 23:30:00")
    assert is_stale_publishing(job, T0, timeout_seconds=1800) is True


def test_stale_publishing_false_when_within_timeout() -> None:
    # updated_at 23:40 > cutoff 23:30 → 未超时
    job = make_job(status="publishing", updated_at="2026-08-07 23:40:00")
    assert is_stale_publishing(job, T0, timeout_seconds=1800) is False


def test_stale_publishing_false_when_not_publishing() -> None:
    job = make_job(status="pending", updated_at="2026-08-07 23:00:00")
    assert is_stale_publishing(job, T0, timeout_seconds=1800) is False
