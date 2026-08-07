"""状态机纯逻辑（ADR-0001 §状态机 + §调度接口 的时间比较）。

- `derive_task_status(jobs)`：task 聚合状态（纯函数，job 变更事务内回写）。
- 时间工具：本地时间 ISO8601 字符串（`YYYY-MM-DD HH:MM:SS`）的解析/格式化/算术，
  调度器比较时统一解析为 datetime（CONTEXT.md 命名约定）。
- 生效值解析：job 排期字段可空 = 继承 task。

本模块为纯领域逻辑，无 IO；测试只断言 seam 外部行为。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from posthub.accounts import now_str

TIME_FMT = "%Y-%m-%d %H:%M:%S"

__all__ = [
    "TIME_FMT",
    "now_str",
    "parse_time",
    "fmt_time",
    "add_seconds",
    "diff_seconds",
    "derive_task_status",
    "effective_publish_mode",
    "effective_publish_at",
]


def parse_time(value: str) -> datetime:
    """解析本地时间 ISO8601 字符串为 datetime。"""
    return datetime.strptime(value, TIME_FMT)


def fmt_time(dt: datetime) -> str:
    """格式化 datetime 为本地时间 ISO8601 字符串。"""
    return dt.strftime(TIME_FMT)


def add_seconds(value: str, seconds: int) -> str:
    """时间字符串加秒，返回同格式字符串。"""
    return fmt_time(parse_time(value) + timedelta(seconds=seconds))


def diff_seconds(a: str, b: str) -> float:
    """a - b 的秒数差（a/b 为时间字符串）。"""
    return (parse_time(a) - parse_time(b)).total_seconds()


def effective_publish_mode(job, task) -> str:
    """job 排期字段可空 = 继承 task。"""
    return job.publish_mode or task.publish_mode


def effective_publish_at(job, task) -> str | None:
    """job 排期字段可空 = 继承 task。"""
    return job.publish_at or task.publish_at


def derive_task_status(jobs) -> str:
    """ADR-0001 task 聚合状态，判定顺序即优先级。

    ```
    success → missed → needs_relogin → manual → failed → publishing → partial → pending
    ```
    其中「全部 pending」先于「存在 pending/publishing」判定，使新建任务聚合为 pending。
    """
    statuses = [j.status for j in jobs]
    if not statuses:
        return "pending"
    if all(s == "success" for s in statuses):
        return "success"
    if all(s == "missed" for s in statuses):
        return "missed"
    if any(s == "needs_relogin" for s in statuses):
        return "needs_relogin"
    if any(s == "manual" for s in statuses):
        return "manual"
    if not any(s == "success" for s in statuses) and any(s == "failed" for s in statuses):
        return "failed"
    if all(s == "pending" for s in statuses):
        return "pending"
    if any(s in ("pending", "publishing") for s in statuses):
        return "publishing"
    if any(s == "success" for s in statuses) and any(
        s in ("failed", "manual", "needs_relogin", "missed") for s in statuses
    ):
        return "partial"
    return "pending"
