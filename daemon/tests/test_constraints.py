"""平台约束注册表测试（CONTEXT.md 权威）。

平台约束是纯领域对象：可按平台查询 min_lead_time / 定时窗口 / 每日上限 / 封面要求。
前端表单校验经 daemon IPC（GET /platform-constraints）引用；本测试断言注册表各字段正确。
"""

from __future__ import annotations

import pytest

from posthub.constraints import (
    PLATFORM_CONSTRAINTS,
    UnknownPlatformError,
    platform_constraints,
    validate_schedule,
)

HOUR = 3600
DAY = 24 * HOUR


def test_douyin_constraints() -> None:
    c = platform_constraints("douyin")
    assert c.platform == "douyin"
    assert c.min_lead_time_seconds == 2 * HOUR
    assert c.schedule_min_seconds == 2 * HOUR
    assert c.schedule_max_seconds == 14 * DAY
    assert c.max_scheduled_per_day is None
    assert c.cover_required is True
    assert c.auto_cover_first_frame is False


def test_xiaohongshu_constraints() -> None:
    c = platform_constraints("xiaohongshu")
    assert c.platform == "xiaohongshu"
    assert c.min_lead_time_seconds == 1 * HOUR
    assert c.schedule_min_seconds == 2 * HOUR
    assert c.schedule_max_seconds == 7 * DAY
    assert c.max_scheduled_per_day is None
    assert c.cover_required is False
    assert c.auto_cover_first_frame is True


def test_wechat_constraints() -> None:
    c = platform_constraints("wechat")
    assert c.platform == "wechat"
    assert c.min_lead_time_seconds == 2 * HOUR
    assert c.schedule_min_seconds == 2 * HOUR
    assert c.schedule_max_seconds == 30 * DAY
    assert c.max_scheduled_per_day == 5
    assert c.cover_required is False
    assert c.auto_cover_first_frame is True


def test_registry_covers_all_platforms() -> None:
    assert set(PLATFORM_CONSTRAINTS) == {"douyin", "xiaohongshu", "wechat"}


def test_unknown_platform_raises() -> None:
    with pytest.raises(UnknownPlatformError):
        platform_constraints("kuaishou")


def test_to_dict_exposes_fields_for_frontend() -> None:
    c = platform_constraints("wechat").to_dict()
    assert c["platform"] == "wechat"
    assert c["min_lead_time_seconds"] == 7200
    assert c["schedule_min_seconds"] == 7200
    assert c["schedule_max_seconds"] == 30 * DAY
    assert c["max_scheduled_per_day"] == 5
    assert c["cover_required"] is False
    assert c["auto_cover_first_frame"] is True


def test_validate_schedule_within_window_returns_no_errors() -> None:
    errors = validate_schedule(
        "douyin",
        publish_at="2099-01-01 12:00:00",
        now="2099-01-01 00:00:00",
    )
    assert errors == []


def test_validate_schedule_too_soon_rejected() -> None:
    # 小红书 min_lead_time=1h 但定时窗口下界 2h → 有效最小提前量 = 2h；1h 不够
    errors = validate_schedule(
        "xiaohongshu",
        publish_at="2099-01-01 01:00:00",
        now="2099-01-01 00:00:00",
    )
    assert errors
    assert "2 小时" in errors[0]


def test_validate_schedule_beyond_window_rejected() -> None:
    # 超过 7 天（定时窗口上界）
    errors = validate_schedule(
        "xiaohongshu",
        publish_at="2099-01-08 00:00:01",
        now="2099-01-01 00:00:00",
    )
    assert errors


def test_validate_schedule_exactly_at_minimum_accepted() -> None:
    # 恰好 2h：有效最小提前量边界
    errors = validate_schedule(
        "douyin",
        publish_at="2099-01-01 02:00:00",
        now="2099-01-01 00:00:00",
    )
    assert errors == []
