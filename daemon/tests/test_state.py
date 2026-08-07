"""状态机纯逻辑测试（ADR-0001 §状态机）。

- `derive_task_status(jobs)`：task 聚合状态按序判定（success→missed→needs_relogin→
  manual→failed→publishing→partial→pending），纯函数。
- 时间工具：本地时间 ISO8601 字符串算术（调度器比较用）。
"""

from __future__ import annotations

from posthub.state import (
    TIME_FMT,
    add_seconds,
    derive_task_status,
    diff_seconds,
    effective_publish_at,
    effective_publish_mode,
)
from posthub.tasks import PlatformJob, Task


def make_job(status: str, **kw) -> PlatformJob:
    base = dict(
        id=1,
        task_id=1,
        account_id=1,
        platform="douyin",
        status=status,
        schedule_policy=None,
        publish_mode=None,
        publish_at=None,
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
        created_at="2026-08-08 00:00:00",
        started_at=None,
        finished_at=None,
        updated_at="2026-08-08 00:00:00",
        retry_at=None,
    )
    base.update(kw)
    return PlatformJob(**base)


# ---- derive_task_status：ADR 判定顺序即优先级 ----

def test_all_success_is_success() -> None:
    assert derive_task_status([make_job("success"), make_job("success")]) == "success"


def test_all_missed_is_missed() -> None:
    assert derive_task_status([make_job("missed"), make_job("missed")]) == "missed"


def test_any_needs_relogin_wins() -> None:
    jobs = [make_job("success", id=1), make_job("needs_relogin", id=2)]
    assert derive_task_status(jobs) == "needs_relogin"


def test_any_manual_wins() -> None:
    jobs = [make_job("failed", id=1), make_job("manual", id=2)]
    assert derive_task_status(jobs) == "manual"


def test_needs_relogin_priority_over_manual() -> None:
    # ADR 判定顺序：needs_relogin 在 manual 之前
    jobs = [make_job("needs_relogin", id=1), make_job("manual", id=2)]
    assert derive_task_status(jobs) == "needs_relogin"


def test_no_success_but_failed_is_failed() -> None:
    jobs = [make_job("failed", id=1), make_job("pending", id=2)]
    assert derive_task_status(jobs) == "failed"


def test_all_pending_is_pending() -> None:
    assert derive_task_status([make_job("pending"), make_job("pending")]) == "pending"


def test_any_publishing_is_publishing() -> None:
    jobs = [make_job("pending", id=1), make_job("publishing", id=2)]
    assert derive_task_status(jobs) == "publishing"


def test_success_plus_pending_is_publishing() -> None:
    jobs = [make_job("success", id=1), make_job("pending", id=2)]
    assert derive_task_status(jobs) == "publishing"


def test_success_plus_failed_is_partial() -> None:
    jobs = [make_job("success", id=1), make_job("failed", id=2)]
    assert derive_task_status(jobs) == "partial"


def test_success_plus_missed_is_partial() -> None:
    jobs = [make_job("success", id=1), make_job("missed", id=2)]
    assert derive_task_status(jobs) == "partial"


def test_single_job_derive() -> None:
    assert derive_task_status([make_job("pending")]) == "pending"
    assert derive_task_status([make_job("publishing")]) == "publishing"
    assert derive_task_status([make_job("success")]) == "success"
    assert derive_task_status([make_job("failed")]) == "failed"
    assert derive_task_status([make_job("manual")]) == "manual"
    assert derive_task_status([make_job("needs_relogin")]) == "needs_relogin"
    assert derive_task_status([make_job("missed")]) == "missed"


def test_empty_jobs_is_pending() -> None:
    assert derive_task_status([]) == "pending"


# ---- 时间工具 ----

def test_time_arithmetic() -> None:
    assert add_seconds("2026-08-08 10:00:00", 30) == "2026-08-08 10:00:30"
    assert add_seconds("2026-08-08 10:00:00", 120) == "2026-08-08 10:02:00"
    assert diff_seconds("2026-08-08 10:05:00", "2026-08-08 10:00:00") == 300
    assert diff_seconds("2026-08-08 10:00:00", "2026-08-08 10:00:30") == -30


def test_time_fmt_constant() -> None:
    assert TIME_FMT == "%Y-%m-%d %H:%M:%S"


# ---- 生效排期值（job 可空 = 继承 task）----

def _make_task(**kw) -> Task:
    base = dict(
        id=1,
        title="标题",
        media_type="video",
        video_path="/tmp/v.mp4",
        image_paths=None,
        caption=None,
        tags=None,
        cover_horizontal=None,
        cover_vertical=None,
        schedule_policy="immediate",
        publish_mode="platform_time",
        publish_at=None,
        silent=0,
        status="pending",
        created_at="2026-08-08 00:00:00",
        updated_at="2026-08-08 00:00:00",
    )
    base.update(kw)
    return Task(**base)


def test_effective_values_fall_back_to_task() -> None:
    task = _make_task(publish_mode="local_time", publish_at="2026-08-09 12:00:00")
    job = make_job("pending", publish_mode=None, publish_at=None)
    assert effective_publish_mode(job, task) == "local_time"
    assert effective_publish_at(job, task) == "2026-08-09 12:00:00"


def test_effective_values_job_overrides_task() -> None:
    task = _make_task(publish_mode="local_time", publish_at="2026-08-09 12:00:00")
    job = make_job(
        "pending", publish_mode="platform_time", publish_at="2026-08-10 12:00:00"
    )
    assert effective_publish_mode(job, task) == "platform_time"
    assert effective_publish_at(job, task) == "2026-08-10 12:00:00"
