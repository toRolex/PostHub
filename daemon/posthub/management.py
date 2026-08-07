"""任务管理查询/操作服务（#18 seam）。

控制者预确认 seam：
- `list_tasks(filters)`：按平台 / 状态 / 时间筛选 + 各 job 明细
- `get_task_detail(task_id)`：单任务明细
- `cancel_task(task_id)`：pending job → failed（未发布任务可取消）
- `retry_job(job_id)`：复用 #17 `retry_job`（终态 → pending）
- `list_logs(filters)`：应用内日志查询

存储经 TaskStore（InMemory / SQLite 可互换）注入；取消/重试动作写 user 日志，
调度器状态变更由 scheduler.py 写日志。本服务是纯领域逻辑，测试只断言 seam 外部行为。
"""

from __future__ import annotations

from posthub.accounts import now_str
from posthub.logs import LogEntry, LogFilters
from posthub.tasks import (
    PlatformJob,
    TaskDetail,
    TaskFilters,
    TaskStore,
)

__all__ = [
    "TaskManagementService",
    "TaskNotFoundError",
    "JobNotFoundError",
]


class TaskNotFoundError(Exception):
    """取消/查询了不存在的任务。"""


class JobNotFoundError(Exception):
    """重试了不存在的 job。"""


class TaskManagementService:
    """任务管理服务：列表 / 明细 / 取消 / 重试 / 日志。"""

    def __init__(self, task_store: TaskStore) -> None:
        self.store = task_store

    def list_tasks(self, filters: TaskFilters | None = None) -> list[TaskDetail]:
        """任务列表（含各 job 明细），按平台 / 状态 / 创建时间区间筛选。"""
        return self.store.list_tasks(filters or TaskFilters())

    def get_task_detail(self, task_id: int) -> TaskDetail | None:
        """单任务详情（task + 全部 job）。"""
        return self.store.get_task_detail(task_id)

    def get_job(self, job_id: int) -> PlatformJob | None:
        """单 job 回读（重试/取消后取更新值）。"""
        return self.store.get_job(job_id)

    def cancel_task(self, task_id: int, now: str | None = None) -> list[PlatformJob]:
        """取消尚未发布的任务：仍 pending 的 job → failed（ADR 无 cancel 状态，
        用 failed + 明确 error 消息最贴合状态机）。已 publishing 的不可取消。
        写一条 user 日志，返回被取消的 job 更新值。
        """
        now = now or now_str()
        detail = self.store.get_task_detail(task_id)
        if detail is None:
            raise TaskNotFoundError(f"任务不存在：{task_id}")
        canceled: list[PlatformJob] = []
        for job in detail.jobs:
            if job.status == "pending":
                self.store.apply_terminal(
                    job.id, now, "failed", "任务已取消", "unknown"
                )
                updated = self.store.get_job(job.id)
                if updated is not None:
                    canceled.append(updated)
        self.store.add_log(
            "info", "user", f"取消任务 #{task_id}", task_id=task_id
        )
        return canceled

    def retry_job(self, job_id: int, now: str | None = None) -> PlatformJob | None:
        """手动重试：终态（failed/manual/needs_relogin）→ pending（#17 retry_job）。
        非终态返回 None（不可重试）。写一条 user 日志，返回更新后的 job。
        """
        now = now or now_str()
        job = self.store.get_job(job_id)
        if job is None:
            raise JobNotFoundError(f"job 不存在：{job_id}")
        if not self.store.retry_job(job_id, now):
            return None
        self.store.add_log(
            "info",
            "user",
            f"重试任务 #{job.task_id} 平台 {job.platform}",
            task_id=job.task_id,
            job_id=job_id,
        )
        return self.store.get_job(job_id)

    def list_logs(self, filters: LogFilters | None = None) -> list[LogEntry]:
        """应用内日志查询（按 level / task_id 筛选）。"""
        return self.store.list_logs(filters or LogFilters())
