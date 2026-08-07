"""应用内日志（ADR-0001 `log` 表）。

`log` 表结构与 ADR 一致；本模块只定义领域类型（LogEntry / LogFilters），
存储读写方法在 TaskStore（tasks.py）上：`add_log` / `list_logs`。

- `level`：debug / info / warn / error
- `source`：scheduler / uploader / user / daemon
- 日志由 daemon 各模块写入（调度器状态变更、取消、重试），前端日志页展示。
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["LogEntry", "LogFilters", "LogLevel", "LogSource"]

LogLevel = str  # debug / info / warn / error
LogSource = str  # scheduler / uploader / user / daemon


@dataclass(frozen=True)
class LogEntry:
    """一条应用内日志（与 ADR-0001 `log` 表行一一对应）。"""

    id: int
    task_id: int | None
    job_id: int | None
    level: str
    source: str
    message: str
    created_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "job_id": self.job_id,
            "level": self.level,
            "source": self.source,
            "message": self.message,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class LogFilters:
    """日志查询筛选（按 level / task_id / limit）。"""

    level: str | None = None
    task_id: int | None = None
    limit: int = 200
