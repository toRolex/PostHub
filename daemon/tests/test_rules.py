"""状态迁移纯函数测试（ADR-0005 §rules.transition）。

- `transition(job, new_status, **target) -> Transition(job_fields, account_effect)`：
  覆盖 6 类迁移（claim / success / terminal / requeue / mark_missed / retry_job）的
  job 字段 + 账号副作用标记。
- rules 从 state.py 导入时间工具，rules 与 state 无环依赖。

只断言纯函数结果（不测 SQL / store 内部）；store 行为由 test_scheduler_store 参数化回归。
"""

from __future__ import annotations

import pytest

from conftest import T0, make_job

from posthub.rules import (
    SET_LAST_PUBLISH_AT,
    SET_NEEDS_RELOGIN,
    Transition,
    transition,
)


def make_job_dict(status: str = "publishing", **kw) -> dict:
    """Sqlite row 形状（dict）；rules 对 PlatformJob 实例与 dict 同等对待。"""
    return make_job(status=status, **kw).to_dict()


# ---- success ----

def test_success_job_fields_and_account_effect() -> None:
    t = transition(
        make_job(), "success", post_id="p1", post_url="https://e/p1", now=T0,
        finished_at=T0,
    )
    assert isinstance(t, Transition)
    assert t.job_fields == {
        "status": "success",
        "post_id": "p1",
        "post_url": "https://e/p1",
        "finished_at": T0,
    }
    assert t.account_effect == SET_LAST_PUBLISH_AT


def test_success_optional_post_fields_none() -> None:
    t = transition(make_job(), "success", finished_at=T0, now=T0)
    assert t.job_fields["post_id"] is None
    assert t.job_fields["post_url"] is None
    assert t.account_effect == SET_LAST_PUBLISH_AT


def test_success_accepts_dict_job() -> None:
    t = transition(make_job_dict(), "success", post_id="p1", finished_at=T0, now=T0)
    assert t.job_fields["status"] == "success"
    assert t.job_fields["post_id"] == "p1"
    assert t.account_effect == SET_LAST_PUBLISH_AT


# ---- terminal（failed / manual / needs_relogin）----

def test_terminal_failed_no_account_effect() -> None:
    t = transition(
        make_job(), "failed", message="网络错误", error_type="network", now=T0, finished_at=T0
    )
    assert t.job_fields == {
        "status": "failed",
        "last_error": "网络错误",
        "last_error_type": "network",
        "finished_at": T0,
    }
    assert t.account_effect is None


def test_terminal_manual_no_account_effect() -> None:
    t = transition(
        make_job(), "manual", message="风控", error_type="risk_control", now=T0, finished_at=T0
    )
    assert t.job_fields["status"] == "manual"
    assert t.job_fields["last_error"] == "风控"
    assert t.account_effect is None


def test_terminal_needs_relogin_sets_account() -> None:
    t = transition(
        make_job(), "needs_relogin", message="登录失效", error_type="auth", now=T0, finished_at=T0
    )
    assert t.job_fields == {
        "status": "needs_relogin",
        "last_error": "登录失效",
        "last_error_type": "auth",
        "finished_at": T0,
    }
    assert t.account_effect == SET_NEEDS_RELOGIN


def test_terminal_message_optional() -> None:
    t = transition(make_job(), "failed", now=T0, finished_at=T0)
    assert t.job_fields["last_error"] is None
    assert t.job_fields["last_error_type"] is None
    assert t.account_effect is None


# ---- requeue（pending + retry_at → 网络退避重试）----

def test_requeue_writes_retry_and_clears_locks() -> None:
    t = transition(
        make_job(),
        "pending",
        retry_at="2026-08-08 00:00:30",
        message="timeout",
        error_type="network",
        now=T0,
    )
    assert t.job_fields == {
        "status": "pending",
        "retry_at": "2026-08-08 00:00:30",
        "last_error": "timeout",
        "last_error_type": "network",
        "locked_at": None,
        "locked_by": None,
        "started_at": None,
    }
    # requeue 不触碰 finished_at（publishing job 本无 finished_at）
    assert "finished_at" not in t.job_fields
    assert t.account_effect is None


def test_requeue_message_optional() -> None:
    t = transition(make_job(), "pending", retry_at="2026-08-08 00:00:30", now=T0)
    assert t.job_fields["last_error"] is None
    assert t.job_fields["last_error_type"] is None
    assert t.account_effect is None


def test_requeue_accepts_dict_job() -> None:
    t = transition(make_job_dict(), "pending", retry_at="2026-08-08 00:00:30", now=T0)
    assert t.job_fields["status"] == "pending"
    assert t.job_fields["retry_at"] == "2026-08-08 00:00:30"
    assert t.account_effect is None


# ---- mark_missed ----

def test_mark_missed_sets_finished_at() -> None:
    t = transition(make_job(), "missed", now=T0, finished_at=T0)
    assert t.job_fields == {"status": "missed", "finished_at": T0}
    assert t.account_effect is None


# ---- retry_job（pending 无 retry_at → 手动重试）----

def test_retry_job_clears_locks_and_finished() -> None:
    t = transition(
        make_job(status="failed", finished_at=T0, locked_at=T0, locked_by="s1"), "pending",
        now=T0,
    )
    assert t.job_fields == {
        "status": "pending",
        "locked_at": None,
        "locked_by": None,
        "finished_at": None,
    }
    # retry_job 不写 retry_at / last_error / started_at（字段差异精确）
    assert "retry_at" not in t.job_fields
    assert "last_error" not in t.job_fields
    assert "last_error_type" not in t.job_fields
    assert "started_at" not in t.job_fields
    assert t.account_effect is None


def test_retry_job_accepts_dict_job() -> None:
    t = transition(make_job_dict(status="needs_relogin"), "pending", now=T0)
    assert t.job_fields["status"] == "pending"
    assert t.job_fields["finished_at"] is None
    assert t.account_effect is None


# ---- 非法目标状态 ----

def test_transition_rejects_unknown_status() -> None:
    with pytest.raises(ValueError):
        transition(make_job(), "paused", now=T0)


# ---- claim（publishing → 锁申请 + attempt_count+1）----

def test_claim_writes_locks_and_attempt_count() -> None:
    t = transition(
        make_job(attempt_count=1), "publishing", now=T0, actor="s1", attempt_count=2
    )
    assert t.job_fields == {
        "status": "publishing",
        "locked_at": T0,
        "locked_by": "s1",
        "started_at": T0,
        "attempt_count": 2,
    }
    assert t.account_effect is None


# ---- rules 从 state 导入，无环依赖 ----

def test_rules_imports_from_state_no_cycle() -> None:
    """rules 依赖 state（导入时间工具与 derive_task_status），无环：两者可同时导入。"""
    import importlib

    importlib.import_module("posthub.rules")
    importlib.import_module("posthub.state")
