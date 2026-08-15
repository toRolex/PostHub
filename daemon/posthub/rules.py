"""调度与状态迁移纯函数单一真源（ADR-0005）。

- `transition(job, new_status, **target) -> Transition`：纯字段计算，返回该迁移
  应写入的 job 字段（job_fields）+ 账号副作用标记（account_effect）。
  覆盖 5 类迁移：success / terminal（failed, manual, needs_relogin）/
  requeue / mark_missed / retry_job。
- account_effect 仅两类紧凑标记：success → `set_last_publish_at`；
  needs_relogin → `set_needs_relogin`；其余 `None`。
- 从 state.py 导入时间工具与 `derive_task_status`（state 不依赖本模块，无环）。
  frontier 谓词 / 排序键、missed 谓词属后续 #26 / #27，本模块暂只做 transition。

本模块为纯领域逻辑，无 IO；副作用执行留在 store 薄包装，规则只计算
「该迁移要写什么 + 附带什么账号副作用」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 从 state 导入时间工具与 derive_task_status（无环依赖，满足 ADR-0005 依赖方向；
# 当前 transition 尚未消费，#26/#27 frontier/missed 谓词将直接用）
from posthub.state import add_seconds, derive_task_status, diff_seconds  # noqa: F401

__all__ = [
    "Transition",
    "transition",
    "SET_LAST_PUBLISH_AT",
    "SET_NEEDS_RELOGIN",
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
