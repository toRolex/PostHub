"""平台约束注册表（CONTEXT.md 权威，本票件核心领域交付）。

纯领域对象：按平台查询发布约束，供前端表单校验引用（经 daemon IPC 暴露）。

| 平台 | 枚举值 | min_lead_time | 定时窗口 | 每日上限 | 封面 |
|---|---|---|---|---|---|
| 抖音 | douyin | 2h | 2h ~ 14 天 | — | 强制（自动选推荐封面） |
| 小红书 | xiaohongshu | 1h | 2h ~ 7 天 | — | 缺封面自动取首帧 |
| 微信视频号 | wechat | 2h | 2h ~ 1 个月 | 5 条/日（工作值，待实测） | 缺封面自动取首帧 |

时间以秒存储（整数），便于前端比较与 IPC 序列化。`min_lead_time` 是「定时发布」
的最小提前量；定时窗口是平台原生定时支持的区间 [schedule_min, schedule_max]。
有效最小提前量 = max(min_lead_time, schedule_min)。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Platform = Literal["douyin", "xiaohongshu", "wechat"]

HOUR = 3600
DAY = 24 * HOUR
MONTH = 30 * DAY

__all__ = [
    "Platform",
    "PlatformConstraint",
    "PLATFORM_CONSTRAINTS",
    "UnknownPlatformError",
    "platform_constraints",
    "validate_schedule",
]

TIME_FMT = "%Y-%m-%d %H:%M:%S"


class UnknownPlatformError(Exception):
    """查询了未注册的平台。"""


@dataclass(frozen=True)
class PlatformConstraint:
    """一个平台的发布约束。字段与 CONTEXT.md 平台约束注册表一一对应。"""

    platform: Platform
    label: str
    min_lead_time_seconds: int          # 定时最小提前量（秒）
    schedule_min_seconds: int           # 定时窗口下界（秒）
    schedule_max_seconds: int           # 定时窗口上界（秒）
    max_scheduled_per_day: int | None   # 每日定时上限（视频号 5，其他无）
    cover_required: bool                # 封面是否强制（抖音 True）
    auto_cover_first_frame: bool        # 缺封面自动取首帧（小红书/视频号 True）

    def to_dict(self) -> dict:
        return {
            "platform": self.platform,
            "label": self.label,
            "min_lead_time_seconds": self.min_lead_time_seconds,
            "schedule_min_seconds": self.schedule_min_seconds,
            "schedule_max_seconds": self.schedule_max_seconds,
            "max_scheduled_per_day": self.max_scheduled_per_day,
            "cover_required": self.cover_required,
            "auto_cover_first_frame": self.auto_cover_first_frame,
        }


PLATFORM_CONSTRAINTS: dict[Platform, PlatformConstraint] = {
    "douyin": PlatformConstraint(
        platform="douyin",
        label="抖音",
        min_lead_time_seconds=2 * HOUR,
        schedule_min_seconds=2 * HOUR,
        schedule_max_seconds=14 * DAY,
        max_scheduled_per_day=None,
        cover_required=True,
        auto_cover_first_frame=False,
    ),
    "xiaohongshu": PlatformConstraint(
        platform="xiaohongshu",
        label="小红书",
        min_lead_time_seconds=1 * HOUR,
        schedule_min_seconds=2 * HOUR,
        schedule_max_seconds=7 * DAY,
        max_scheduled_per_day=None,
        cover_required=False,
        auto_cover_first_frame=True,
    ),
    "wechat": PlatformConstraint(
        platform="wechat",
        label="微信视频号",
        min_lead_time_seconds=2 * HOUR,
        schedule_min_seconds=2 * HOUR,
        schedule_max_seconds=1 * MONTH,
        max_scheduled_per_day=5,
        cover_required=False,
        auto_cover_first_frame=True,
    ),
}


def platform_constraints(platform: str) -> PlatformConstraint:
    """按平台查询约束；未注册平台抛 UnknownPlatformError。"""
    try:
        return PLATFORM_CONSTRAINTS[platform]  # type: ignore[index]
    except KeyError as exc:
        raise UnknownPlatformError(f"未知平台：{platform!r}") from exc


def _parse_time(value: str) -> datetime:
    return datetime.strptime(value, TIME_FMT)


def _fmt_hours(seconds: int) -> str:
    return f"{seconds // HOUR} 小时"


def validate_schedule(
    platform: str,
    *,
    publish_at: str,
    now: str | None = None,
) -> list[str]:
    """校验定时时间是否符合平台约束，返回错误消息列表（空 = 通过）。

    有效最小提前量 = max(min_lead_time, schedule_min)；定时窗口上界 = schedule_max。
    超出则返回中文错误消息，供前端展示 / 后端防御性校验复用。
    """
    c = platform_constraints(platform)
    if now is None:
        now = datetime.now().strftime(TIME_FMT)
    publish_dt = _parse_time(publish_at)
    now_dt = _parse_time(now)
    lead = int((publish_dt - now_dt).total_seconds())

    effective_min = max(c.min_lead_time_seconds, c.schedule_min_seconds)
    if lead < effective_min:
        return [f"定时发布时间距现在至少 {_fmt_hours(effective_min)}（{c.label}）"]
    if lead > c.schedule_max_seconds:
        max_hours = c.schedule_max_seconds // HOUR
        return [f"定时窗口最大 {max_hours} 小时（{c.label}）"]
    return []
