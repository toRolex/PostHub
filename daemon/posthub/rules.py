"""调度与状态迁移纯函数单一真源（ADR-0005）。

- `transition(job, new_status, **target) -> Transition`：纯字段计算，返回该迁移
  应写入的 job 字段（job_fields）+ 账号副作用标记（account_effect）。
  覆盖 5 类迁移：success / terminal（failed, manual, needs_relogin）/
  requeue / mark_missed / retry_job。
- account_effect 仅两类紧凑标记：success → `set_last_publish_at`；
  needs_relogin → `set_needs_relogin`；其余 `None`。
- frontier 谓词 + 排序键（#26）：`is_job_eligible` 组合判定（定时到点、退避未到期、
  限速、账号 active、同账号严格串行、创建序排队），`frontier_sort_key` 排序键；
  跨 job 派生上下文（publishing_accounts / pending_min）由 store 算好传入，规则侧纯。
- missed 谓词属后续 #27，本模块暂不做。
- 从 state.py 导入时间工具与 `derive_task_status`（state 不依赖本模块，无环）。

本模块为纯领域逻辑，无 IO；副作用执行留在 store 薄包装，规则只计算
「该迁移要写什么 + 附带什么账号副作用」与「frontier 可领取判定 / 排序」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 从 state 导入时间工具与 derive_task_status（无环依赖，满足 ADR-0005 依赖方向；
# frontier 谓词用 effective_publish_at / diff_seconds，#27 missed 谓词将用 add_seconds）
from posthub.state import (
    add_seconds,  # noqa: F401  # #27 missed 谓词用
    derive_task_status,  # noqa: F401  # 依赖方向锚点（transition 暂未消费）
    diff_seconds,
    effective_publish_at,
)

__all__ = [
    "Transition",
    "transition",
    "SET_LAST_PUBLISH_AT",
    "SET_NEEDS_RELOGIN",
    "is_time_due",
    "is_backoff_expired",
    "is_account_active",
    "is_rate_limited",
    "is_serial_eligible",
    "is_job_eligible",
    "frontier_sort_key",
]

SET_LAST_PUBLISH_AT = "set_last_publish_at"
SET_NEEDS_RELOGIN = "set_needs_relogin"

_TERMINAL_STATUSES = ("failed", "manual", "needs_relogin")


@dataclass(frozen=True)
class Transition:
    """一次状态迁移的纯计算结果：要写入的 job 字段 + 账号副作用标记。

    - `job_fields`：迁移应写入的 platform_job 字段 dict（status / finished_at /
      retry_at / last_error / last_error_type / post_id / post_url / 清锁标记等）。
      `updated_at` 由 store 统一置 now，rules 不参与。
    - `account_effect`：`None` / `"set_last_publish_at"` / `"set_needs_relogin"`。
    """

    job_fields: dict[str, Any]
    account_effect: str | None


def transition(job: Any, new_status: str, **target: Any) -> Transition:
    """计算一次状态迁移应写入的 job 字段与账号副作用（纯函数）。

    `job` 为 `PlatformJob` 实例或 dict（Sqlite row），目前只作迁移上下文传入；
    `new_status` 为 success / failed / manual / needs_relogin / pending / missed；
    `**target` 承载附加目标字段（post_id / post_url / message / error_type /
    retry_at / finished_at）。`pending` 按是否携带 `retry_at` 区分 requeue
    （网络退避重试）与 retry_job（终态手动重试）。
    """
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

    if new_status in _TERMINAL_STATUSES:
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
        # retry_job：终态手动重试（failed/manual/needs_relogin → pending），清锁+finished
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


# ---- #26 frontier 可领取谓词 + 排序键 ----

# 跨 job 派生上下文（publishing_accounts / pending_min）由 store 计算后作为参数传入，
# 本组函数保持纯（无 IO、无 store 访问），InMemory 与 Sqlite 共享同一判定与排序。


def is_time_due(job: Any, task: Any, now: str) -> bool:
    """定时到点：有效 publish_at 为空（立即发布）或已到点（<= now）。"""
    pub_at = effective_publish_at(job, task)
    return pub_at is None or pub_at <= now


def is_backoff_expired(job: Any, now: str) -> bool:
    """退避未到期：retry_at 为空或已到点（<= now）。"""
    return job.retry_at is None or job.retry_at <= now


def is_account_active(account: Any) -> bool:
    """账号可发布：存在且状态为 active。"""
    return account is not None and account.status == "active"


def is_rate_limited(account: Any, now: str, rate_limit_seconds: int = 300) -> bool:
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


def is_job_eligible(
    job: Any,
    task: Any,
    account: Any,
    now: str,
    *,
    rate_limit_seconds: int = 300,
    publishing_accounts: set[int],
    pending_min: dict[int, int],
) -> bool:
    """frontier 可领取全量判定（纯函数）。

    判定顺序：定时到点 → 退避未到期 → 账号 active → 限速 → 同账号串行 + 创建序；
    全部满足才 True。`publishing_accounts` / `pending_min` 为 store 派生的跨 job 上下文。
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
