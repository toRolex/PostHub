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

import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from posthub.accounts import AccountStore, now_str
from posthub.constraints import validate_schedule

Platform = Literal["douyin", "xiaohongshu", "wechat"]
SchedulePolicy = Literal["immediate", "scheduled"]
PublishMode = Literal["platform_time", "local_time"]

__all__ = [
    "Platform",
    "Task",
    "PlatformJob",
    "NewTaskSpec",
    "PlatformJobSpec",
    "TaskStore",
    "TaskValidationError",
    "UnknownAccountError",
    "AccountPlatformMismatchError",
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


class TaskStore(Protocol):
    """任务存储 seam：创建任务（task + jobs）并支持回读。InMemory / SQLite 可互换。"""

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        ...

    def get_task(self, task_id: int) -> Task | None:
        ...

    def list_jobs(self, task_id: int) -> list[PlatformJob]:
        ...

    def close(self) -> None:
        ...


def _validate_new(new: NewTaskSpec, accounts: AccountStore) -> list[PlatformJobSpec]:
    """校验入参并返回解析后的 job 清单；失败抛 TaskValidationError 系异常。

    校验顺序：形状（标题/排期/jobs 非空）→ 账号存在 → 平台匹配 → 定时约束。
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
        self._next_task_id = 1
        self._next_job_id = 1
        self._lock = threading.Lock()

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        with self._lock:
            jobs_spec = _validate_new(new, self._accounts)
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
                """
            )
            self._conn.commit()

    def create_task(self, new: NewTaskSpec) -> tuple[Task, list[PlatformJob]]:
        with self._lock:
            jobs_spec = _validate_new(new, self._accounts)
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
