"""调度器（ADR-0001 §调度 / 重试 / 限速 接口）。

消费 #16 `create_task` 落库的 pending jobs，经唯一 seam `engine.execute`
（浏览器执行器依赖注入，测试替换为 fake）执行，并把状态机迁移持久化到
task / platform_job / account。

`Scheduler.tick(now)` 是可被测试直接调用的推进时间入口：标记 missed →
frontier 领取 → 并发执行 → 按错误类型映射终态 / 网络类退避重试。

网络类重试语义（CONTEXT.md 重试策略，本实现对齐「重试 2 次退避 30s → 2min」）：
attempt_count 在领取时 +1；网络失败时若 attempt_count <= max_network_retries(=2)
退回 pending（退避按 attempt_count 取 30s → 2min），用尽（attempt_count=3）→ failed。
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from typing import Protocol

from posthub.accounts import AccountStore, now_str
from posthub.engine import (
    AccountContext,
    BrowserExecutor,
    ExecutionContext,
    JobUpdate,
    TaskSpec,
    UploadResult,
    execute,
)
from posthub.state import (
    add_seconds,
    effective_publish_at,
    effective_publish_mode,
)
from posthub.tasks import TaskStore


class Scheduler:
    """调度器：一个 tick = 一个调度周期（missed 扫描 + 领取 + 并发执行 + 结果落库）。"""

    def __init__(
        self,
        task_store: TaskStore,
        account_store: AccountStore,
        executor: BrowserExecutor,
        *,
        scheduler_id: str = "scheduler-1",
        concurrency: int = 3,
        rate_limit_seconds: int = 300,
        retry_backoff: tuple[int, ...] = (30, 120),
        max_network_retries: int = 2,
        missed_tolerance_seconds: int = 600,
        publishing_timeout_seconds: int = 1800,
    ) -> None:
        self.task_store = task_store
        self.account_store = account_store
        self.executor = executor
        self.scheduler_id = scheduler_id
        self.concurrency = concurrency
        self.rate_limit_seconds = rate_limit_seconds
        self.retry_backoff = retry_backoff
        self.max_network_retries = max_network_retries
        self.missed_tolerance_seconds = missed_tolerance_seconds
        self.publishing_timeout_seconds = publishing_timeout_seconds

    async def tick(self, now: str | None = None) -> list[JobUpdate]:
        """一个调度周期，返回本周期产生的 job_updates 流。

        顺序：1) 定时窗口 missed 扫描；2) publishing 超时兜底 missed；
        3) 循环「领取一批 → 并发执行 → 应用结果」直到无更多可领取 job。
        """
        now = now or now_str()
        all_updates: list[JobUpdate] = []

        for job in self.task_store.list_pending_missed(now, self.missed_tolerance_seconds):
            self.task_store.mark_missed(job.id, now)
            self.task_store.add_log(
                "warn",
                "scheduler",
                f"任务 #{job.task_id} 平台 {job.platform} 错过发布窗口",
                task_id=job.task_id,
                job_id=job.id,
            )
            all_updates.append(
                JobUpdate(
                    job_id=str(job.id),
                    task_id=str(job.task_id),
                    platform=job.platform,
                    status="missed",
                    attempt_count=job.attempt_count,
                )
            )

        for job in self.task_store.list_stale_publishing(now, self.publishing_timeout_seconds):
            self.task_store.mark_missed(job.id, now)
            self.task_store.add_log(
                "error",
                "scheduler",
                f"任务 #{job.task_id} 平台 {job.platform} 发布超时，标记为错过",
                task_id=job.task_id,
                job_id=job.id,
            )
            all_updates.append(
                JobUpdate(
                    job_id=str(job.id),
                    task_id=str(job.task_id),
                    platform=job.platform,
                    status="missed",
                    attempt_count=job.attempt_count,
                )
            )

        while True:
            claimed = self.task_store.claim_eligible_jobs(
                now,
                self.concurrency,
                self.scheduler_id,
                rate_limit_seconds=self.rate_limit_seconds,
            )
            if not claimed:
                break
            batch = await asyncio.gather(
                *[self._execute_job(job, now) for job in claimed]
            )
            for updates in batch:
                all_updates.extend(updates)
        return all_updates

    def retry_job(self, job_id: int, now: str | None = None) -> bool:
        """手动重试：终态（failed/manual/needs_relogin）→ pending，重试次数保留。"""
        return self.task_store.retry_job(job_id, now or now_str())

    async def _execute_job(self, job, now: str) -> list[JobUpdate]:
        """执行一个已领取的 job：构建 task_spec → engine.execute → 按结果落库。"""
        task = self.task_store.get_task(job.task_id)
        account = self.account_store.get(job.account_id)
        if task is None or account is None:
            self.task_store.apply_terminal(
                job.id, now, "failed", "task/account 不存在", "unknown"
            )
            self.task_store.add_log(
                "error",
                "scheduler",
                f"任务 #{job.task_id} 平台 {job.platform} task/account 不存在",
                task_id=job.task_id,
                job_id=job.id,
            )
            return [
                JobUpdate(
                    job_id=str(job.id),
                    task_id=str(job.task_id),
                    platform=job.platform,
                    status="failed",
                    message="task/account 不存在",
                    error_type="unknown",
                    attempt_count=job.attempt_count,
                )
            ]

        spec = self._build_spec(job, task)
        ctx = ExecutionContext(
            account=AccountContext(
                account_id=str(account.id),
                platform=account.platform,
                cdp_url=f"http://127.0.0.1:{account.cdp_port}",
                name=account.name,
            )
        )
        publishing = JobUpdate(
            job_id=str(job.id),
            task_id=str(task.id),
            platform=job.platform,
            status="publishing",
            attempt_count=job.attempt_count,
        )
        try:
            updates = await execute(spec, ctx, self.executor)
        except Exception as exc:
            updates = [
                JobUpdate(
                    job_id=str(job.id),
                    task_id=str(task.id),
                    platform=job.platform,
                    status="manual",
                    message=str(exc),
                    error_type="unknown",
                    attempt_count=job.attempt_count,
                )
            ]
        terminal = dataclasses.replace(
            updates[-1], job_id=str(job.id), attempt_count=job.attempt_count
        )

        if terminal.status == "success":
            self.task_store.apply_success(job.id, now, terminal.post_id, terminal.post_url)
            self.task_store.add_log(
                "info",
                "uploader",
                f"任务 #{task.id} 平台 {job.platform} 发布成功",
                task_id=task.id,
                job_id=job.id,
            )
            return [publishing, terminal]

        if (
            terminal.status == "failed"
            and terminal.error_type == "network"
            and job.attempt_count <= self.max_network_retries
        ):
            # 网络类自动重试：退回 pending，指数退避 30s → 2min
            backoff = self.retry_backoff[
                min(job.attempt_count - 1, len(self.retry_backoff) - 1)
            ]
            retry_at = add_seconds(now, backoff)
            self.task_store.requeue(job.id, now, retry_at, terminal.message, "network")
            self.task_store.add_log(
                "warn",
                "uploader",
                f"任务 #{task.id} 平台 {job.platform} 网络错误，{backoff}s 后重试",
                task_id=task.id,
                job_id=job.id,
            )
            retry_update = dataclasses.replace(
                terminal,
                status="pending",
                post_id=None,
                post_url=None,
                error_type="network",
            )
            return [publishing, retry_update]

        # 终态：failed（非网络重试用尽）/ manual / needs_relogin
        self.task_store.apply_terminal(
            job.id, now, terminal.status, terminal.message, terminal.error_type
        )
        level = "error" if terminal.status == "failed" else "warn"
        reason = terminal.message or terminal.status
        self.task_store.add_log(
            level,
            "uploader",
            f"任务 #{task.id} 平台 {job.platform} → {terminal.status}: {reason}",
            task_id=task.id,
            job_id=job.id,
        )
        return [publishing, terminal]

    @staticmethod
    def _build_spec(job, task) -> TaskSpec:
        tags = tuple(json.loads(task.tags)) if task.tags else ()
        platform_fields = json.loads(job.platform_fields) if job.platform_fields else {}
        return TaskSpec(
            task_id=str(task.id),
            platform=job.platform,
            account_id=str(job.account_id),
            video_path=task.video_path or "",
            title=task.title,
            caption=task.caption,
            tags=tags,
            cover_horizontal=task.cover_horizontal,
            cover_vertical=task.cover_vertical,
            publish_mode=effective_publish_mode(job, task),
            publish_at=effective_publish_at(job, task),
            platform_fields=platform_fields,
        )
