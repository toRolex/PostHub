"""任务创建服务（ADR-0001 `task` / `platform_job` 表）。

控制者预确认 seam：`create_task(NewTaskSpec) -> (task, jobs)`。

- 输入选平台/账号/排期，落库一个 task + N 个 platform_job。
- 初始状态：task `pending`，每个 job `pending`。
- job 排期字段（schedule_policy / publish_mode / publish_at）可空 = 继承 task。
- 校验：标题必填；scheduled 必须有 publish_at；每个 job 的账号存在且
  `job.platform == account.platform`（ADR 不变量）；定时提前量满足平台约束
  （防御性校验，前端为主）。状态机流转属 #17，本模块不实现。

InMemory 与 SQLite 实现可互换（复用 accounts.py 的连接管理模式）。
"""

from __future__ import annotations

import dataclasses
import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from posthub.accounts import AccountStore, now_str
from posthub.constraints import validate_schedule
from posthub.logs import LogEntry, LogFilters
from posthub.rules import (
    SET_LAST_PUBLISH_AT,
    SET_NEEDS_RELOGIN,
    transition,
)
from posthub.state import (
    add_seconds,
    derive_task_status,
    diff_seconds,
    effective_publish_at,
    effective_publish_mode,
)

Platform = Literal["douyin", "xiaohongshu", "wechat"]
SchedulePolicy = Literal["immediate", "scheduled"]
PublishMode = Literal["platform_time", "local_time"]

__all__ = [
    "Platform",
    "Task",
    "PlatformJob",
    "NewTaskSpec",
    "PlatformJobSpec",
    "TaskFilters",
    "TaskDetail",
    "TaskStore",
    "TaskValidationError",
    "UnknownAccountError",
    "AccountPlatformMismatchError",
    "validate_task_spec",
    "InMemoryTaskStore",
    "SqliteTaskStore",
]


class TaskValidationError(Exception):
    """任务入参不合法（标题空 / scheduled 缺 publish_at / 无平台 / 定时提前量不足）。"""


class UnknownAccountError(Exception):
    """任务引用了不存在的账号。"""


class AccountPlatformMismatchError(Exception):
    """不变量违反：job.platform != account.platform。"""


@dataclass(frozen=True)
class PlatformJobSpec:
    """创建任务时勾选的单个平台 + 账号。"""

    platform: Platform
    account_id: int


@dataclass(frozen=True)
class NewTaskSpec:
    """创建任务的入参（task 共享源值 + 各平台 job 的账号选择）。"""

    title: str
    video_path: str | None = None
    caption: str | None = None
    tags: list[str] | None = None
    cover_horizontal: str | None = None
    cover_vertical: str | None = None
    media_type: Literal["video", "note"] = "video"
    image_paths: list[str] | None = None
    schedule_policy: SchedulePolicy = "immediate"
    publish_mode: PublishMode = "platform_time"
    publish_at: str | None = None
    silent: bool = False
    jobs: list[PlatformJobSpec] = field(default_factory=list)


@dataclass(frozen=True)
class Task:
    """一条任务记录（与 ADR-0001 `task` 表行一一对应）。"""

    id: int
    title: str
    media_type: str
    video_path: str | None
    image_paths: str | None          # JSON 数组字符串
    caption: str | None
    tags: str | None                 # JSON 数组字符串
    cover_horizontal: str | None
    cover_vertical: str | None
    schedule_policy: str
    publish_mode: str
    publish_at: str | None
    silent: int
    status: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "media_type": self.media_type,
            "video_path": self.video_path,
            "image_paths": self.image_paths,
            "caption": self.caption,
            "tags": self.tags,
            "cover_horizontal": self.cover_horizontal,
            "cover_vertical": self.cover_vertical,
            "schedule_policy": self.schedule_policy,
            "publish_mode": self.publish_mode,
            "publish_at": self.publish_at,
            "silent": self.silent,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class PlatformJob:
    """一个平台子任务（与 ADR-0001 `platform_job` 表行一一对应）。"""

    id: int
    task_id: int
    account_id: int
    platform: Platform
    status: str
    schedule_policy: str | None      # 可空 = 继承 task
    publish_mode: str | None
    publish_at: str | None
    retry_at: str | None             # 网络类退避：到此刻前不领取（NULL = 立即可领取）
    title: str | None
    caption: str | None
    tags: str | None
    cover_horizontal: str | None
    cover_vertical: str | None
    platform_fields: str | None
    post_id: str | None
    post_url: str | None
    attempt_count: int
    last_error: str | None
    last_error_type: str | None
    locked_at: str | None
    locked_by: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    updated_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "account_id": self.account_id,
            "platform": self.platform,
            "status": self.status,
            "schedule_policy": self.schedule_policy,
            "publish_mode": self.publish_mode,
            "publish_at": self.publish_at,
            "retry_at": self.retry_at,
            "title": self.title,
            "caption": self.caption,
            "tags": self.tags,
            "cover_horizontal": self.cover_horizontal,
            "cover_vertical": self.cover_vertical,
            "platform_fields": self.platform_fields,
            "post_id": self.post_id,
            "post_url": self.post_url,
            "attempt_count": self.attempt_count,
            "last_error": self.last_error,
            "last_error_type": self.last_error_type,
            "locked_at": self.locked_at,
            "locked_by": self.locked_by,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class TaskFilters:
    """任务列表查询筛选（#18 任务管理页 / #21：平台 / 状态 / 创建时间区间）。"""

    platform: Platform | None = None
    status: str | None = None
    from_ts: str | None = None
    to_ts: str | None = None


@dataclass(frozen=True)
class TaskDetail:
    """一条任务 + 其全部平台子任务明细（任务列表 / 任务管理页列表/详情数据）。"""

    task: Task
    jobs: list[PlatformJob]

    def to_dict(self) -> dict:
        return {
            "task": self.task.to_dict(),
            "jobs": [j.to_dict() for j in self.jobs],
        }


class TaskStore(Protocol):
    """任务存储 seam：创建任务（task + jobs）并支持回读。InMemory / SQLite 可互换。

    扩展（#17 调度器原语）：frontier 领取 + 状态迁移持久化 + missed 扫描。
    扩展（#18 任务管理）：list_tasks / get_task_detail / get_job + 日志读写。
    扩展（#21 任务状态可查）：list_tasks 供 daemon `GET /tasks` 暴露 job 状态，
    使 manual / needs_relogin 在任务 UI 明确呈现；与 #18 任务管理页共用同一方法。
    调度 / 状态机为纯领域逻辑（scheduler.py），存储层只做原子持久化。
    """

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        ...

    def get_task(self, task_id: int) -> Task | None:
        ...

    def list_jobs(self, task_id: int) -> list[PlatformJob]:
        ...

    def list_tasks(self, filters: "TaskFilters | None" = None) -> list["TaskDetail"]:
        """任务列表（含各 job 明细），新在前；按平台 / 状态 / 创建时间筛选。"""

    def claim_eligible_jobs(
        self,
        now: str,
        limit: int,
        scheduler_id: str,
        *,
        rate_limit_seconds: int = 300,
    ) -> list[PlatformJob]:
        """Frontier 查询 + 乐观锁领取一批可执行 job。

        领取成功者 status → publishing，attempt_count+1，locked_* / started_at 置 now。
        同账号严格串行（无 publishing、取 MIN(pending)）、跨平台并发上限 limit、
        限速（距 last_publish_at >= rate_limit_seconds）、仅 active 账号、
        publish_at/retry_at 已到期。
        """

    def apply_success(self, job_id: int, now: str, post_id: str | None = None,
                      post_url: str | None = None) -> None:
        """job → success，回写账号 last_publish_at，同事务重算 task.status。"""

    def apply_terminal(self, job_id: int, now: str, status: str,
                       message: str | None = None, error_type: str | None = None) -> None:
        """job → failed / manual / needs_relogin；needs_relogin 顺带账号置位；
        同事务重算 task.status。"""

    def requeue(self, job_id: int, now: str, retry_at: str,
                message: str | None = None, error_type: str | None = None) -> None:
        """job → pending（网络类退避重试），写 retry_at，重算 task.status。"""

    def mark_missed(self, job_id: int, now: str) -> None:
        """job → missed（定时窗口错过 / publishing 超时兜底），重算 task.status。"""

    def retry_job(self, job_id: int, now: str) -> bool:
        """终态（failed/manual/needs_relogin）手动重试 → pending；重试次数保留。"""

    # ---- #18 任务管理 + 日志 ----

    def get_task_detail(self, task_id: int) -> TaskDetail | None:
        """单任务详情（task + 全部 job）。"""

    def get_job(self, job_id: int) -> PlatformJob | None:
        """单 job 回读（重试/取消后取更新值）。"""

    def add_log(self, level: str, source: str, message: str, *,
                task_id: int | None = None, job_id: int | None = None) -> None:
        """写一条应用内日志（ADR-0001 `log` 表）。"""

    def list_logs(self, filters: LogFilters | None = None) -> list[LogEntry]:
        """日志查询（按 level / task_id 筛选），新在前，limit 截断。"""

    def list_pending_missed(self, now: str, tolerance_seconds: int) -> list[PlatformJob]:
        """local_time 定时且 publish_at 已过超过容忍窗口仍 pending 的 jobs（候选 missed）。"""

    def list_stale_publishing(self, now: str, timeout_seconds: int) -> list[PlatformJob]:
        """publishing 超过超时阈值无心跳（按 updated_at）的 jobs（兜底 missed）。"""

    def delete_account_jobs(self, account_id: int) -> None:
        """删除账号的全部 platform_job 及因此清空的 task / log（删除账号时清理关联，#15）。"""

    def close(self) -> None:
        ...


def validate_task_spec(
    new: NewTaskSpec, accounts: AccountStore
) -> list[PlatformJobSpec]:
    """校验任务入参并返回解析后的 job 清单；失败抛 TaskValidationError 系异常。

    校验顺序：形状（标题/排期/jobs 非空）→ 账号存在 → 平台匹配 → 定时约束。
    唯一校验链：`create_task` 与 manifest 批量导入（confirm_import）复用本函数，
    避免两套校验逻辑漂移。
    """
    if not new.title or not new.title.strip():
        raise TaskValidationError("标题不能为空")
    if new.schedule_policy == "scheduled" and not new.publish_at:
        raise TaskValidationError("定时发布必须填写发布时间")
    if not new.jobs:
        raise TaskValidationError("至少选择一个发布平台")

    for jspec in new.jobs:
        account = accounts.get(jspec.account_id)
        if account is None:
            raise UnknownAccountError(f"账号不存在：{jspec.account_id}")
        if account.platform != jspec.platform:
            raise AccountPlatformMismatchError(
                f"账号 {jspec.account_id} 属于平台 {account.platform}，"
                f"不能发布到 {jspec.platform}"
            )

    if new.schedule_policy == "scheduled" and new.publish_at:
        for jspec in new.jobs:
            errors = validate_schedule(jspec.platform, publish_at=new.publish_at)
            if errors:
                raise TaskValidationError("；".join(errors))
    return new.jobs


class InMemoryTaskStore:
    """内存实现：测试用，与 SqliteTaskStore 行为一致。"""

    def __init__(self, accounts: AccountStore) -> None:
        self._accounts = accounts
        self._tasks: dict[int, Task] = {}
        self._jobs: dict[int, list[PlatformJob]] = {}
        self._logs: list[LogEntry] = []
        self._next_task_id = 1
        self._next_job_id = 1
        self._next_log_id = 1
        self._lock = threading.Lock()

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        with self._lock:
            jobs_spec = validate_task_spec(new, self._accounts)
            ts = now_str()
            task = Task(
                id=self._next_task_id,
                title=new.title.strip(),
                media_type=new.media_type,
                video_path=new.video_path,
                image_paths=json.dumps(new.image_paths, ensure_ascii=False)
                if new.image_paths is not None
                else None,
                caption=new.caption,
                tags=json.dumps(new.tags, ensure_ascii=False) if new.tags is not None else None,
                cover_horizontal=new.cover_horizontal,
                cover_vertical=new.cover_vertical,
                schedule_policy=new.schedule_policy,
                publish_mode=new.publish_mode,
                publish_at=new.publish_at,
                silent=1 if new.silent else 0,
                status="pending",
                created_at=ts,
                updated_at=ts,
            )
            jobs: list[PlatformJob] = []
            for jspec in jobs_spec:
                job = PlatformJob(
                    id=self._next_job_id,
                    task_id=task.id,
                    account_id=jspec.account_id,
                    platform=jspec.platform,
                    status="pending",
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
                    created_at=ts,
                    started_at=None,
                    finished_at=None,
                    updated_at=ts,
                )
                jobs.append(job)
                self._next_job_id += 1
            self._tasks[task.id] = task
            self._jobs[task.id] = jobs
            self._next_task_id += 1
            return task, jobs

    def get_task(self, task_id: int) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list_jobs(self, task_id: int) -> list[PlatformJob]:
        with self._lock:
            return list(self._jobs.get(task_id, []))

    # ---- #18 任务管理 + 日志 / #21 任务状态可查 ----

    def list_tasks(self, filters: TaskFilters | None = None) -> list[TaskDetail]:
        filters = filters or TaskFilters()
        with self._lock:
            details: list[TaskDetail] = []
            for task in self._tasks.values():
                if filters.status is not None and task.status != filters.status:
                    continue
                if filters.from_ts is not None and task.created_at < filters.from_ts:
                    continue
                if filters.to_ts is not None and task.created_at > filters.to_ts:
                    continue
                jobs = self._jobs.get(task.id, [])
                if filters.platform is not None and not any(
                    j.platform == filters.platform for j in jobs
                ):
                    continue
                details.append(TaskDetail(task=task, jobs=list(jobs)))
            details.sort(key=lambda d: d.task.id, reverse=True)  # 新在前
            return details

    def get_task_detail(self, task_id: int) -> TaskDetail | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            return TaskDetail(task=task, jobs=list(self._jobs.get(task_id, [])))

    def get_job(self, job_id: int) -> PlatformJob | None:
        with self._lock:
            return self._find_job(job_id)

    def add_log(self, level: str, source: str, message: str, *,
                task_id: int | None = None, job_id: int | None = None) -> None:
        with self._lock:
            self._logs.append(
                LogEntry(
                    id=self._next_log_id,
                    task_id=task_id,
                    job_id=job_id,
                    level=level,
                    source=source,
                    message=message,
                    created_at=now_str(),
                )
            )
            self._next_log_id += 1

    def list_logs(self, filters: LogFilters | None = None) -> list[LogEntry]:
        filters = filters or LogFilters()
        with self._lock:
            hits = [
                e for e in self._logs
                if (filters.level is None or e.level == filters.level)
                and (filters.task_id is None or e.task_id == filters.task_id)
            ]
            hits.sort(key=lambda e: e.id, reverse=True)  # 新在前
            return hits[: filters.limit]

    # ---- #17 调度器原语 ----

    def _all_jobs(self) -> list[PlatformJob]:
        return [job for jobs in self._jobs.values() for job in jobs]

    def _find_job(self, job_id: int) -> PlatformJob | None:
        for job in self._all_jobs():
            if job.id == job_id:
                return job
        return None

    def _update_job(self, job_id: int, **changes) -> PlatformJob | None:
        job = self._find_job(job_id)
        if job is None:
            return None
        new = dataclasses.replace(job, **changes)
        jobs = self._jobs[job.task_id]
        for i, j in enumerate(jobs):
            if j.id == job_id:
                jobs[i] = new
                break
        return new

    def _recompute_task_status(self, task_id: int, now: str) -> None:
        task = self._tasks.get(task_id)
        if task is None:
            return
        status = derive_task_status(self._jobs.get(task_id, []))
        self._tasks[task_id] = dataclasses.replace(task, status=status, updated_at=now)

    def claim_eligible_jobs(
        self,
        now: str,
        limit: int,
        scheduler_id: str,
        *,
        rate_limit_seconds: int = 300,
    ) -> list[PlatformJob]:
        with self._lock:
            candidates: list[PlatformJob] = []
            for job in self._all_jobs():
                if job.status != "pending":
                    continue
                task = self._tasks.get(job.task_id)
                if task is None:
                    continue
                pub_at = effective_publish_at(job, task)
                if pub_at is not None and pub_at > now:
                    continue  # 定时未到点
                if job.retry_at is not None and job.retry_at > now:
                    continue  # 退避未到期
                candidates.append(job)

            def account_eligible(job: PlatformJob) -> bool:
                acc = self._accounts.get(job.account_id)
                if acc is None or acc.status != "active":
                    return False
                if acc.last_publish_at is not None and diff_seconds(now, acc.last_publish_at) < rate_limit_seconds:
                    return False
                return True

            publishing_accounts = {
                j.account_id for j in self._all_jobs() if j.status == "publishing"
            }
            pending_min: dict[int, int] = {}
            for job in candidates:
                cur = pending_min.get(job.account_id)
                if cur is None or job.id < cur:
                    pending_min[job.account_id] = job.id

            def serial_eligible(job: PlatformJob) -> bool:
                # 同账号严格串行：无 publishing 且是本账号 pending 中最先创建
                return (
                    job.account_id not in publishing_accounts
                    and job.id == pending_min[job.account_id]
                )

            candidates = [j for j in candidates if account_eligible(j) and serial_eligible(j)]
            # ORDER BY (publish_at IS NULL) DESC, publish_at ASC, id ASC
            candidates.sort(key=lambda j: (j.publish_at is not None, j.publish_at or "", j.id))

            claimed: list[PlatformJob] = []
            for job in candidates:
                if len(claimed) >= limit:
                    break
                updated = self._update_job(
                    job.id,
                    status="publishing",
                    locked_at=now,
                    locked_by=scheduler_id,
                    started_at=now,
                    attempt_count=job.attempt_count + 1,
                    updated_at=now,
                )
                if updated is not None:
                    claimed.append(updated)
            return claimed

    def apply_success(self, job_id: int, now: str, post_id: str | None = None,
                      post_url: str | None = None) -> None:
        with self._lock:
            job = self._find_job(job_id)
            if job is None:
                return
            t = transition(
                job, "success", post_id=post_id, post_url=post_url, finished_at=now
            )
            self._update_job(job_id, updated_at=now, **t.job_fields)
            if t.account_effect == SET_LAST_PUBLISH_AT:
                self._accounts.set_last_publish_at(job.account_id, now)
            self._recompute_task_status(job.task_id, now)

    def apply_terminal(self, job_id: int, now: str, status: str,
                       message: str | None = None, error_type: str | None = None) -> None:
        with self._lock:
            job = self._find_job(job_id)
            if job is None:
                return
            t = transition(
                job, status, message=message, error_type=error_type, finished_at=now
            )
            self._update_job(job_id, updated_at=now, **t.job_fields)
            if t.account_effect == SET_NEEDS_RELOGIN:
                self._accounts.set_status(job.account_id, "needs_relogin")
            self._recompute_task_status(job.task_id, now)

    def requeue(self, job_id: int, now: str, retry_at: str,
                message: str | None = None, error_type: str | None = None) -> None:
        with self._lock:
            job = self._find_job(job_id)
            if job is None:
                return
            t = transition(
                job, "pending", retry_at=retry_at, message=message, error_type=error_type
            )
            self._update_job(job_id, updated_at=now, **t.job_fields)
            self._recompute_task_status(job.task_id, now)

    def mark_missed(self, job_id: int, now: str) -> None:
        with self._lock:
            job = self._find_job(job_id)
            if job is None:
                return
            t = transition(job, "missed", finished_at=now)
            self._update_job(job_id, updated_at=now, **t.job_fields)
            self._recompute_task_status(job.task_id, now)

    def retry_job(self, job_id: int, now: str) -> bool:
        with self._lock:
            job = self._find_job(job_id)
            if job is None or job.status not in ("failed", "manual", "needs_relogin"):
                return False
            t = transition(job, "pending")
            self._update_job(job_id, updated_at=now, **t.job_fields)
            self._recompute_task_status(job.task_id, now)
            return True

    def list_pending_missed(self, now: str, tolerance_seconds: int) -> list[PlatformJob]:
        with self._lock:
            cutoff = add_seconds(now, -tolerance_seconds)
            hits: list[PlatformJob] = []
            for job in self._all_jobs():
                if job.status != "pending":
                    continue
                task = self._tasks.get(job.task_id)
                if task is None:
                    continue
                if effective_publish_mode(job, task) != "local_time":
                    continue
                pub_at = effective_publish_at(job, task)
                if pub_at is not None and pub_at <= cutoff:
                    hits.append(job)
            return hits

    def list_stale_publishing(self, now: str, timeout_seconds: int) -> list[PlatformJob]:
        with self._lock:
            cutoff = add_seconds(now, -timeout_seconds)
            return [
                job for job in self._all_jobs()
                if job.status == "publishing" and job.updated_at <= cutoff
            ]

    def delete_account_jobs(self, account_id: int) -> None:
        with self._lock:
            affected: list[int] = []
            for task_id in list(self._jobs.keys()):
                jobs = self._jobs[task_id]
                remaining = [j for j in jobs if j.account_id != account_id]
                if len(remaining) == len(jobs):
                    continue
                affected.append(task_id)
                if remaining:
                    self._jobs[task_id] = remaining
                else:
                    del self._jobs[task_id]
                    self._tasks.pop(task_id, None)
                    # 空 task 连带清理其日志
                    self._logs = [e for e in self._logs if e.task_id != task_id]
            now = now_str()
            for task_id in affected:
                if task_id in self._tasks:
                    self._recompute_task_status(task_id, now)

    def close(self) -> None:
        pass


class SqliteTaskStore:
    """SQLite 实现：持久化 task / platform_job（重启不丢）。

    与 SqliteAccountStore 同库（`~/.posthub/posthub.db`），复用连接管理模式
    （check_same_thread=False + lock）。建 task/platform_job 表（幂等 IF NOT EXISTS）。
    """

    def __init__(self, db_path: str | Path, accounts: AccountStore) -> None:
        self._db_path = str(db_path)
        self._accounts = accounts
        self._lock = threading.Lock()
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._create_schema()

    def _create_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS batch (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    name          TEXT    NOT NULL,
                    folder_path   TEXT    NOT NULL,
                    manifest_path TEXT,
                    status        TEXT    NOT NULL DEFAULT 'imported'
                        CHECK (status IN ('imported','in_progress','done','partial','failed')),
                    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS task (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id         INTEGER REFERENCES batch(id),
                    title            TEXT    NOT NULL,
                    media_type       TEXT    NOT NULL DEFAULT 'video'
                        CHECK (media_type IN ('video','note')),
                    video_path       TEXT,
                    image_paths      TEXT,
                    caption          TEXT,
                    tags             TEXT,
                    cover_horizontal TEXT,
                    cover_vertical   TEXT,
                    schedule_policy  TEXT    NOT NULL DEFAULT 'immediate'
                        CHECK (schedule_policy IN ('immediate','scheduled')),
                    publish_mode     TEXT    NOT NULL DEFAULT 'platform_time'
                        CHECK (publish_mode IN ('platform_time','local_time')),
                    publish_at       TEXT,
                    silent           INTEGER NOT NULL DEFAULT 0,
                    status           TEXT    NOT NULL DEFAULT 'pending',
                    created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    updated_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                );
                CREATE TABLE IF NOT EXISTS platform_job (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id          INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
                    account_id       INTEGER NOT NULL REFERENCES account(id),
                    platform         TEXT    NOT NULL
                        CHECK (platform IN ('douyin','xiaohongshu','wechat')),
                    status           TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','publishing','success','failed',
                                          'manual','needs_relogin','missed')),
                    schedule_policy  TEXT,
                    publish_mode     TEXT,
                    publish_at       TEXT,
                    retry_at         TEXT,
                    title            TEXT,
                    caption          TEXT,
                    tags             TEXT,
                    cover_horizontal TEXT,
                    cover_vertical   TEXT,
                    platform_fields  TEXT,
                    post_id          TEXT,
                    post_url         TEXT,
                    attempt_count    INTEGER NOT NULL DEFAULT 0,
                    last_error       TEXT,
                    last_error_type  TEXT
                        CHECK (last_error_type IN ('network','auth','risk_control',
                                                   'platform_reject','unknown')),
                    locked_at        TEXT,
                    locked_by        TEXT,
                    created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    started_at       TEXT,
                    finished_at      TEXT,
                    updated_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    UNIQUE (task_id, platform, account_id)
                );
                CREATE INDEX IF NOT EXISTS idx_job_task ON platform_job(task_id);
                CREATE INDEX IF NOT EXISTS idx_job_status_publish
                    ON platform_job(status, publish_at);
                CREATE INDEX IF NOT EXISTS idx_job_account_status
                    ON platform_job(account_id, status);
                CREATE TABLE IF NOT EXISTS log (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id    INTEGER REFERENCES task(id) ON DELETE CASCADE,
                    job_id     INTEGER REFERENCES platform_job(id) ON DELETE CASCADE,
                    level      TEXT NOT NULL
                        CHECK (level IN ('debug','info','warn','error')),
                    source     TEXT NOT NULL,
                    message    TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
                );
                CREATE INDEX IF NOT EXISTS idx_log_job ON log(job_id);
                CREATE INDEX IF NOT EXISTS idx_log_created ON log(created_at);
                """
            )
            self._conn.commit()
            # 幂等迁移：旧库补 retry_at 列（#17 网络类退避）
            try:
                self._conn.execute(
                    "ALTER TABLE platform_job ADD COLUMN retry_at TEXT"
                )
                self._conn.commit()
            except sqlite3.OperationalError:
                pass  # 列已存在

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        with self._lock:
            jobs_spec = validate_task_spec(new, self._accounts)
            ts = now_str()
            try:
                cur = self._conn.execute(
                    """
                    INSERT INTO task
                        (title, media_type, video_path, image_paths, caption, tags,
                         cover_horizontal, cover_vertical, schedule_policy, publish_mode,
                         publish_at, silent, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (
                        new.title.strip(),
                        new.media_type,
                        new.video_path,
                        json.dumps(new.image_paths, ensure_ascii=False)
                        if new.image_paths is not None
                        else None,
                        new.caption,
                        json.dumps(new.tags, ensure_ascii=False)
                        if new.tags is not None
                        else None,
                        new.cover_horizontal,
                        new.cover_vertical,
                        new.schedule_policy,
                        new.publish_mode,
                        new.publish_at,
                        1 if new.silent else 0,
                        ts,
                        ts,
                    ),
                )
                task_id = cur.lastrowid
                for jspec in jobs_spec:
                    self._conn.execute(
                        """
                        INSERT INTO platform_job
                            (task_id, account_id, platform, status,
                             schedule_policy, publish_mode, publish_at,
                             created_at, updated_at)
                        VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
                        """,
                        (task_id, jspec.account_id, jspec.platform, ts, ts),
                    )
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            task = self._fetch_task(task_id)
            assert task is not None
            return task, self._list_jobs(task_id)

    def _fetch_task(self, task_id: int) -> Task | None:
        cur = self._conn.execute("SELECT * FROM task WHERE id = ?", (task_id,))
        row = cur.fetchone()
        return self._row_to_task(row) if row is not None else None

    @staticmethod
    def _row_to_task(row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            title=row["title"],
            media_type=row["media_type"],
            video_path=row["video_path"],
            image_paths=row["image_paths"],
            caption=row["caption"],
            tags=row["tags"],
            cover_horizontal=row["cover_horizontal"],
            cover_vertical=row["cover_vertical"],
            schedule_policy=row["schedule_policy"],
            publish_mode=row["publish_mode"],
            publish_at=row["publish_at"],
            silent=row["silent"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def get_task(self, task_id: int) -> Task | None:
        with self._lock:
            return self._fetch_task(task_id)

    def _list_jobs(self, task_id: int) -> list[PlatformJob]:
        cur = self._conn.execute(
            "SELECT * FROM platform_job WHERE task_id = ? ORDER BY id ASC",
            (task_id,),
        )
        return [self._row_to_job(row) for row in cur.fetchall()]

    def list_jobs(self, task_id: int) -> list[PlatformJob]:
        with self._lock:
            return self._list_jobs(task_id)

    # ---- #18 任务管理 + 日志 / #21 任务状态可查 ----

    def list_tasks(self, filters: TaskFilters | None = None) -> list[TaskDetail]:
        filters = filters or TaskFilters()
        with self._lock:
            conditions: list[str] = []
            params: list[object] = []
            if filters.platform is not None:
                conditions.append(
                    "EXISTS (SELECT 1 FROM platform_job j WHERE j.task_id = t.id"
                    " AND j.platform = ?)"
                )
                params.append(filters.platform)
            if filters.status is not None:
                conditions.append("t.status = ?")
                params.append(filters.status)
            if filters.from_ts is not None:
                conditions.append("t.created_at >= ?")
                params.append(filters.from_ts)
            if filters.to_ts is not None:
                conditions.append("t.created_at <= ?")
                params.append(filters.to_ts)
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            rows = self._conn.execute(
                f"SELECT t.* FROM task t {where} ORDER BY t.id DESC", params
            ).fetchall()
            details: list[TaskDetail] = []
            for row in rows:
                task = self._row_to_task(row)
                details.append(
                    TaskDetail(task=task, jobs=self._list_jobs(task.id))
                )
            return details

    def get_task_detail(self, task_id: int) -> TaskDetail | None:
        with self._lock:
            task = self._fetch_task(task_id)
            if task is None:
                return None
            return TaskDetail(task=task, jobs=self._list_jobs(task_id))

    def get_job(self, job_id: int) -> PlatformJob | None:
        with self._lock:
            row = self._fetch_job(job_id)
            return self._row_to_job(row) if row is not None else None

    def add_log(self, level: str, source: str, message: str, *,
                task_id: int | None = None, job_id: int | None = None) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO log (task_id, job_id, level, source, message)
                VALUES (?, ?, ?, ?, ?)
                """,
                (task_id, job_id, level, source, message),
            )
            self._conn.commit()

    def list_logs(self, filters: LogFilters | None = None) -> list[LogEntry]:
        filters = filters or LogFilters()
        with self._lock:
            conditions: list[str] = []
            params: list[object] = []
            if filters.level is not None:
                conditions.append("level = ?")
                params.append(filters.level)
            if filters.task_id is not None:
                conditions.append("task_id = ?")
                params.append(filters.task_id)
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.append(filters.limit)
            rows = self._conn.execute(
                f"SELECT * FROM log {where} ORDER BY id DESC LIMIT ?", params
            ).fetchall()
            return [self._row_to_log(row) for row in rows]

    @staticmethod
    def _row_to_log(row: sqlite3.Row) -> LogEntry:
        return LogEntry(
            id=row["id"],
            task_id=row["task_id"],
            job_id=row["job_id"],
            level=row["level"],
            source=row["source"],
            message=row["message"],
            created_at=row["created_at"],
        )

    # ---- #17 调度器原语 ----

    def _fetch_job(self, job_id: int) -> sqlite3.Row | None:
        cur = self._conn.execute(
            "SELECT * FROM platform_job WHERE id = ?", (job_id,)
        )
        return cur.fetchone()

    def _apply_job_fields(self, job_id: int, now: str, fields: dict) -> None:
        """按 rules.transition 返回的 job_fields 做持久化（字段 + updated_at 置 now）。"""
        if not fields:
            return
        cols = ", ".join(f"{name}=?" for name in fields)
        params = list(fields.values()) + [now, job_id]
        self._conn.execute(
            f"UPDATE platform_job SET {cols}, updated_at=? WHERE id=?",
            params,
        )

    def _recompute_task_status(self, task_id: int, now: str) -> None:
        status = derive_task_status(self._list_jobs(task_id))
        self._conn.execute(
            "UPDATE task SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, task_id),
        )

    def claim_eligible_jobs(
        self,
        now: str,
        limit: int,
        scheduler_id: str,
        *,
        rate_limit_seconds: int = 300,
    ) -> list[PlatformJob]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT j.*
                FROM platform_job j
                JOIN task t ON t.id = j.task_id
                WHERE j.status = 'pending'
                  AND (COALESCE(j.publish_at, t.publish_at) IS NULL
                       OR COALESCE(j.publish_at, t.publish_at) <= :now)
                  AND (j.retry_at IS NULL OR j.retry_at <= :now)
                  AND j.account_id NOT IN (
                      SELECT account_id FROM platform_job WHERE status = 'publishing'
                  )
                  AND j.id = (SELECT MIN(j2.id) FROM platform_job j2
                              WHERE j2.account_id = j.account_id
                                AND j2.status = 'pending')
                ORDER BY (COALESCE(j.publish_at, t.publish_at) IS NULL) DESC,
                         COALESCE(j.publish_at, t.publish_at) ASC, j.id ASC
                LIMIT :limit
                """,
                {"now": now, "limit": limit},
            ).fetchall()

            claimed: list[PlatformJob] = []
            for row in rows:
                if len(claimed) >= limit:
                    break
                job = self._row_to_job(row)
                acc = self._accounts.get(job.account_id)
                if acc is None or acc.status != "active":
                    continue
                if acc.last_publish_at is not None and diff_seconds(
                    now, acc.last_publish_at
                ) < rate_limit_seconds:
                    continue
                cur = self._conn.execute(
                    """
                    UPDATE platform_job
                       SET status='publishing', locked_at=?, locked_by=?,
                           started_at=?, attempt_count=attempt_count+1, updated_at=?
                     WHERE id=? AND status='pending'
                    """,
                    (now, scheduler_id, now, now, job.id),
                )
                if cur.rowcount == 1:
                    row2 = self._fetch_job(job.id)
                    if row2 is not None:
                        claimed.append(self._row_to_job(row2))
            self._conn.commit()
            return claimed

    def apply_success(self, job_id: int, now: str, post_id: str | None = None,
                      post_url: str | None = None) -> None:
        with self._lock:
            job = self._fetch_job(job_id)
            if job is None:
                return
            t = transition(
                job, "success", post_id=post_id, post_url=post_url, finished_at=now
            )
            self._apply_job_fields(job_id, now, t.job_fields)
            if t.account_effect == SET_LAST_PUBLISH_AT:
                self._accounts.set_last_publish_at(job["account_id"], now)
            self._recompute_task_status(job["task_id"], now)
            self._conn.commit()

    def apply_terminal(self, job_id: int, now: str, status: str,
                       message: str | None = None, error_type: str | None = None) -> None:
        with self._lock:
            job = self._fetch_job(job_id)
            if job is None:
                return
            t = transition(
                job, status, message=message, error_type=error_type, finished_at=now
            )
            self._apply_job_fields(job_id, now, t.job_fields)
            if t.account_effect == SET_NEEDS_RELOGIN:
                self._accounts.set_status(job["account_id"], "needs_relogin")
            self._recompute_task_status(job["task_id"], now)
            self._conn.commit()

    def requeue(self, job_id: int, now: str, retry_at: str,
                message: str | None = None, error_type: str | None = None) -> None:
        with self._lock:
            job = self._fetch_job(job_id)
            if job is None:
                return
            t = transition(
                job, "pending", retry_at=retry_at, message=message, error_type=error_type
            )
            self._apply_job_fields(job_id, now, t.job_fields)
            self._recompute_task_status(job["task_id"], now)
            self._conn.commit()

    def mark_missed(self, job_id: int, now: str) -> None:
        with self._lock:
            job = self._fetch_job(job_id)
            if job is None:
                return
            t = transition(job, "missed", finished_at=now)
            self._apply_job_fields(job_id, now, t.job_fields)
            self._recompute_task_status(job["task_id"], now)
            self._conn.commit()

    def retry_job(self, job_id: int, now: str) -> bool:
        with self._lock:
            job = self._fetch_job(job_id)
            if job is None or job["status"] not in ("failed", "manual", "needs_relogin"):
                return False
            t = transition(job, "pending")
            self._apply_job_fields(job_id, now, t.job_fields)
            self._recompute_task_status(job["task_id"], now)
            self._conn.commit()
            return True

    def list_pending_missed(self, now: str, tolerance_seconds: int) -> list[PlatformJob]:
        with self._lock:
            cutoff = add_seconds(now, -tolerance_seconds)
            rows = self._conn.execute(
                """
                SELECT j.*
                FROM platform_job j
                JOIN task t ON t.id = j.task_id
                WHERE j.status = 'pending'
                  AND COALESCE(j.publish_mode, t.publish_mode) = 'local_time'
                  AND COALESCE(j.publish_at, t.publish_at) IS NOT NULL
                  AND COALESCE(j.publish_at, t.publish_at) <= :cutoff
                ORDER BY j.id ASC
                """,
                {"cutoff": cutoff},
            ).fetchall()
            return [self._row_to_job(row) for row in rows]

    def list_stale_publishing(self, now: str, timeout_seconds: int) -> list[PlatformJob]:
        with self._lock:
            cutoff = add_seconds(now, -timeout_seconds)
            rows = self._conn.execute(
                "SELECT * FROM platform_job WHERE status='publishing' AND updated_at <= ?",
                (cutoff,),
            ).fetchall()
            return [self._row_to_job(row) for row in rows]

    def delete_account_jobs(self, account_id: int) -> None:
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT task_id FROM platform_job WHERE account_id = ?",
                (account_id,),
            ).fetchall()
            task_ids = [r["task_id"] for r in rows]
            # 显式清理日志（未开 PRAGMA foreign_keys，级联不生效）：该账号 job 的日志
            self._conn.execute(
                "DELETE FROM log WHERE job_id IN "
                "(SELECT id FROM platform_job WHERE account_id = ?)",
                (account_id,),
            )
            # 删除该账号的 job
            self._conn.execute(
                "DELETE FROM platform_job WHERE account_id = ?", (account_id,)
            )
            for task_id in task_ids:
                remaining = self._conn.execute(
                    "SELECT COUNT(*) AS c FROM platform_job WHERE task_id = ?",
                    (task_id,),
                ).fetchone()["c"]
                if remaining == 0:
                    # 无剩余平台子任务：先清 task 日志再删 task
                    self._conn.execute("DELETE FROM log WHERE task_id = ?", (task_id,))
                    self._conn.execute("DELETE FROM task WHERE id = ?", (task_id,))
                else:
                    self._recompute_task_status(task_id, now_str())
            self._conn.commit()

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> PlatformJob:
        return PlatformJob(
            id=row["id"],
            task_id=row["task_id"],
            account_id=row["account_id"],
            platform=row["platform"],
            status=row["status"],
            schedule_policy=row["schedule_policy"],
            publish_mode=row["publish_mode"],
            publish_at=row["publish_at"],
            retry_at=row["retry_at"],
            title=row["title"],
            caption=row["caption"],
            tags=row["tags"],
            cover_horizontal=row["cover_horizontal"],
            cover_vertical=row["cover_vertical"],
            platform_fields=row["platform_fields"],
            post_id=row["post_id"],
            post_url=row["post_url"],
            attempt_count=row["attempt_count"],
            last_error=row["last_error"],
            last_error_type=row["last_error_type"],
            locked_at=row["locked_at"],
            locked_by=row["locked_by"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            updated_at=row["updated_at"],
        )

    def close(self) -> None:
        with self._lock:
            self._conn.close()
