"""调度与状态迁移纯函数单一真源（ADR-0005）。

- `transition(job, new_status, **target) -> Transition`：纯字段计算，返回该迁移
  应写入的 job 字段（job_fields）+ 账号副作用标记（account_effect）。
  覆盖迁移：claim / success / terminal（failed, manual, needs_relogin）/
  requeue / mark_missed / retry_job；claim 含锁申请（locked_at / locked_by /
  started_at / attempt_count+1）。
- account_effect 仅两类紧凑标记：success → `set_last_publish_at`；
  needs_relogin → `set_needs_relogin`；其余 `None`（store 按此标记执行副作用）。
- frontier 谓词 + 排序键（#26）：`is_job_eligible` 组合判定（定时到点、退避未到期、
  限速、账号 active、同账号严格串行、创建序排队），`frontier_sort_key` 排序键；
  跨 job 派生上下文（publishing_accounts / pending_min）由 store 算好传入，规则侧纯。
- missed 判定谓词（#27）：`is_pending_missed`（local_time 定时超容忍窗口）与
  `is_stale_publishing`（publishing 按 updated_at 超时）；两份 store 的
  list_pending_missed / list_stale_publishing 扫描共享同一谓词。
- 从 state.py 导入时间工具（state 不依赖本模块，无环）。

本模块为纯领域逻辑，无 IO；副作用执行留在 store 薄包装，规则只计算
「该迁移要写什么 + 附带什么账号副作用」与「frontier 可领取判定 / 排序」与
「missed 判定」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

# 从 state 导入时间工具（无环依赖，满足 ADR-0005 依赖方向；frontier 谓词用
# effective_publish_at / diff_seconds，missed 谓词用 add_seconds / effective_publish_mode）
from posthub.state import (
    add_seconds,
    diff_seconds,
    effective_publish_at,
    effective_publish_mode,
)

__all__ = [
    "Transition",
    "transition",
    "TERMINAL_STATUSES",
    "SET_LAST_PUBLISH_AT",
    "SET_NEEDS_RELOGIN",
    "is_time_due",
    "is_backoff_expired",
    "is_account_active",
    "is_rate_limited",
    "is_serial_eligible",
    "derive_pending_min",
    "is_job_eligible",
    "frontier_sort_key",
    "is_pending_missed",
    "is_stale_publishing",
]

SET_LAST_PUBLISH_AT = "set_last_publish_at"
SET_NEEDS_RELOGIN = "set_needs_relogin"

TERMINAL_STATUSES = ("failed", "manual", "needs_relogin")


@dataclass(frozen=True)
class Transition:
    """一次状态迁移的纯计算结果：要写入的 job 字段 + 账号副作用标记。

    - `job_fields`：迁移应写入的 platform_job 字段 dict（status / finished_at /
      retry_at / last_error / last_error_type / post_id / post_url / 锁字段 /
      attempt_count 等）。`updated_at` 由 store 统一置 now，rules 不参与。
    - `account_effect`：`None` / `"set_last_publish_at"` / `"set_needs_relogin"`。
    """

    job_fields: dict[str, Any]
    account_effect: str | None


def transition(
    job: Any,
    new_status: str,
    *,
    now: str,
    actor: str | None = None,
    **target: Any,
) -> Transition:
    """计算一次状态迁移应写入的 job 字段与账号副作用（纯函数）。

    `job` 为 `PlatformJob` 实例或 dict（Sqlite row），仅作签名契约传入
    （ADR-0005 规定 `transition(job, new_status, **target)`），本阶段各迁移
    均为纯 set 计算，函数体不读取 `job` 的既有字段。
    `new_status` 为 publishing（claim）/ success / failed / manual / needs_relogin /
    pending / missed（claim → publishing 由 store 领取时消费；pending 按是否携带
    `retry_at` 区分 requeue 与 retry_job）。
    `next` 承载附加目标字段（post_id / post_url / message / error_type /
    retry_at / finished_at / accuem）。`now` / `actor` 为 claim 迁移专用：
    锁申请用（locked_at / locked_by / started_at 置 now，attempt_count+1）。

    - claim：写入 6 个字段（publishing / 锁 / started_at / attempt_count+1），
      不含 finished_at / last_error*。
    - retry_job（pending 无 retry_at）：仅 status / 清锁 / 清 finished，不动
      attempt_count（重试次数保留）。

    本函数不侧面副作用；`account_effect` 标记由 store 按常量执行。
    """
    if new_status == "publishing":
        assert now is not None and actor is not None
        return Transition(
            job_fields={
                "status": "publishing",
                "locked_at": now,
                "locked_by": actor,
                "started_at": now,
                "attempt_count": target["attempt_count"],
            },
            account_effect=None,
        )

    if new_status == "success":
        return Transition(
            job_fields={
                "status": "success",
                "post_id": target.get("post_id"),
                "post_url": target.get("post_url"),
                "finished_at": target["finished_at"],
            },
            account_effect=SET_LAST_PUBLISH_AT,
        )

    if new_status in TERMINAL_STATUSES:
        fields = {
            "status": new_status,
            "last_error": target.get("message"),
            "last_error_type": target.get("error_type"),
            "finished_at": target["finished_at"],
        }
        effect = SET_NEEDS_RELOGIN if new_status == "needs_relogin" else None
        return Transition(job_fields=fields, account_effect=effect)

    if new_status == "missed":
        return Transition(
            job_fields={
                "status": "missed",
                "finished_at": target["finished_at"],
            },
            account_effect=None,
        )

    if new_status == "pending":
        if "retry_at" in target:
            # requeue：网络类退避重试（publishing → pending），清锁、写退避/错误
            return Transition(
                job_fields={
                    "status": "pending",
                    "retry_at": target["retry_at"],
                    "last_error": target.get("message"),
                    "last_error_type": target.get("error_type"),
                    "locked_at": None,
                    "locked_by": None,
                    "started_at": None,
                },
                account_effect=None,
            )
        # retry_job：终态手动重试（failed/manual/needs_relogin → pending），清锁+清 finished
        return Transition(
            job_fields={
                "status": "pending",
                "locked_at": None,
                "locked_by": None,
                "finished_at": None,
            },
            account_effect=None,
        )

    raise ValueError(f"不支持的迁移目标状态：{new_status}")


# ---- frontier 可领取谓词 + 排序键 ----

# 跨 job 派生上下文（publishing_accounts / pending_min）由 store 计算后作为参数传入，
# 本组函数保持纯（无 IO、无 store 访问），InMemory 与 Sqlite 共享同一判定与排序。


def is_time_due(job: Any, task: Any, now: str) -> bool:
    """定时到点：有效 publish_at 为空（立即发布）或已到点（<= now）。"""
    pub_at = effective_publish_at(job, task)
    return pub_at is None or pub_at <= now


def is_backoff_expired(job: Any, now: str) -> bool:
    """退避已到期：retry_at 为空或已到点（<= now）→ True（可领取）。"""
    return job.retry_at is None or job.retry_at <= now


def is_account_active(account: Any) -> bool:
    """账号可发布：存在且状态为 active。"""
    return account is not None and account.status == "active"


def is_rate_limited(account: Any, now: str, rate_limit_seconds: int) -> bool:
    """限速：距上次发布 < rate_limit_seconds 秒 → True（不可领取）。"""
    if account is None or account.last_publish_at is None:
        return False
    return diff_seconds(now, account.last_publish_at) < rate_limit_seconds


def is_serial_eligible(job: Any, publishing_accounts: set[int], pending_min: dict[int, int]) -> bool:
    """同账号严格串行 + 创建序排队：无 publishing 且是本账号 pending 中最小 id。

    `publishing_accounts`：status='publishing' 的账号 id 集合。
    `pending_min`：{account_id: 该账号最小 pending job id}（创建序）。
    两者均由 store 从全量 job 派生后传入，规则侧保持纯。
    """
    return (
        job.account_id not in publishing_accounts
        and job.id == pending_min.get(job.account_id)
    )


def derive_pending_min(pending_jobs: Iterable[tuple[int, int]]) -> dict[int, int]:
    """派生每账号最小 pending job id（创建序排队）——纯函数，两份 store 共用。

    `pending_jobs`：已过滤为 pending 的 `(account_id, job_id)` 序列，由 store 投影
    （InMemory 遍历全部 job 取 status=='pending'；Sqlite 用宽拉取结果）。对全部
    pending 计算（含定时未到点 / 退避中），保证「同账号按创建序排队」不被定时 /
    退避跳过（与 Sqlite 语义一致，#26 收敛点）。
    """
    pending_min: dict[int, int] = {}
    for account_id, job_id in pending_jobs:
        cur = pending_min.get(account_id)
        if cur is None or job_id < cur:
            pending_min[account_id] = job_id
    return pending_min


def is_job_eligible(
    job: Any,
    task: Any,
    account: Any,
    now: str,
    *,
    rate_limit_seconds: int,
    publishing_accounts: set[int],
    pending_min: dict[int, int],
) -> bool:
    """frontier 可领取全量判定（纯函数）。

    判定顺序：定时到点 → 退避未到期 → 账号 active → 限速 → 同账号串行 + 创建序；
    全部满足才 True。`publishing_accounts` / `pending_min` 为 store 派生的跨 job 上下文；
    `rate_limit_seconds` 由 store 从 scheduler 配置传入（规则的唯一真源在调用方）。
    """
    if not is_time_due(job, task, now):
        return False
    if not is_backoff_expired(job, now):
        return False
    if not is_account_active(account):
        return False
    if is_rate_limited(account, now, rate_limit_seconds):
        return False
    return is_serial_eligible(job, publishing_accounts, pending_min)


def frontier_sort_key(job: Any, task: Any) -> tuple[bool, str, int]:
    """frontier 排序键：与 SQL `ORDER BY (publish_at IS NULL) DESC, publish_at ASC, id ASC` 同语义。

    返回 `(生效 publish_at 为空?, 生效 publish_at 或 "", job.id)`，升序：
    空 publish_at 在前，非空按 publish_at 升序，同值按 id 升序。
    生效 publish_at = job 排期非空取 job，否则继承 task（effective_publish_at）。
    """
    pub_at = effective_publish_at(job, task)
    return (pub_at is not None, pub_at or "", job.id)


# ---- missed 判定谓词 ----

# 两份 store 的 list_pending_missed / list_stale_publishing 扫描共享同一判定：
# store 只负责候选迭代（InMemory 遍历 / Sqlite 宽候选拉取），本组函数保持纯
# （无 IO、无 store 访问）。


def is_pending_missed(job: Any, task: Any, now: str, tolerance_seconds: int) -> bool:
    """pending-missed 判定：local_time 定时超容忍窗口（纯函数）。

    job 为 pending、生效 publish_mode 为 `local_time`、生效 publish_at 非空且
    `publish_at <= now - tolerance_seconds` → True（错过定时窗口的 missed 候选）。
    """
    if job.status != "pending":
        return False
    if effective_publish_mode(job, task) != "local_time":
        return False
    pub_at = effective_publish_at(job, task)
    if pub_at is None:
        return False
    return pub_at <= add_seconds(now, -tolerance_seconds)


def is_stale_publishing(job: Any, now: str, timeout_seconds: int) -> bool:
    """stale-publishing 判定：publishing 按 updated_at 超时（纯函数）。

    job 为 publishing 且 `updated_at <= now - timeout_seconds` → True
    （publishing 超时兜底 missed 的候选）。
    """
    if job.status != "publishing":
        return False
    return job.updated_at <= add_seconds(now, -timeout_seconds)