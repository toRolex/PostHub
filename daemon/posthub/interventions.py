"""人工介入事件（issue #21 seam #1）：job → manual / needs_relogin 时的可观测事件。

D9 兜底交互：验证码挂起（manual）、登录态失效（needs_relogin）都需人工介入。
本模块是 daemon 侧的事件接口：

- `NewIntervention`：一次人工介入事件的载荷（调度器构造，hub 赋 id）。
- `HumanIntervention`：已存储的事件（带 id / acknowledged_at）。
- `InterventionNotifier`：调度器在 job 进入 manual / needs_relogin 时调用的 seam。
- `NoopInterventionNotifier`：默认空实现（未注入时忽略事件）。
- `InMemoryInterventionHub`：内存存储未处理事件，供前端轮询 `/interventions` 消费
  （acknowledge 后不再出现在 pending 中，避免重复弹窗）。

状态流转（CONTEXT.md 重试策略，调度器已实现）：`risk_control / unknown → manual`、
`auth → needs_relogin`（顺带账号置 needs_relogin）。本模块只负责「发出可观测事件」。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Literal, Protocol

from posthub.accounts import now_str
from posthub.engine import ErrorType, Platform

InterventionKind = Literal["manual", "needs_relogin"]

__all__ = [
    "InterventionKind",
    "NewIntervention",
    "HumanIntervention",
    "InterventionNotifier",
    "NoopInterventionNotifier",
    "InMemoryInterventionHub",
]


@dataclass(frozen=True)
class NewIntervention:
    """人工介入事件的载荷（id / acknowledged_at 由 hub 赋值）。"""

    kind: InterventionKind
    job_id: int
    task_id: int
    account_id: int
    platform: Platform
    message: str | None = None
    error_type: ErrorType | None = None
    created_at: str = ""


@dataclass(frozen=True)
class HumanIntervention:
    """已存储的人工介入事件（含 id / 处理时间）。"""

    id: int
    kind: InterventionKind
    job_id: int
    task_id: int
    account_id: int
    platform: Platform
    message: str | None = None
    error_type: ErrorType | None = None
    created_at: str = ""
    acknowledged_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "job_id": self.job_id,
            "task_id": self.task_id,
            "account_id": self.account_id,
            "platform": self.platform,
            "message": self.message,
            "error_type": self.error_type,
            "created_at": self.created_at,
            "acknowledged_at": self.acknowledged_at,
        }


class InterventionNotifier(Protocol):
    """人工介入事件 seam：调度器在终态 manual / needs_relogin 时调用。"""

    def notify(self, new: NewIntervention) -> HumanIntervention:
        ...


class NoopInterventionNotifier:
    """默认空实现：未注入 notifier 时忽略事件（调度器不依赖事件通道）。"""

    def notify(self, new: NewIntervention) -> HumanIntervention:
        return HumanIntervention(
            id=0,
            kind=new.kind,
            job_id=new.job_id,
            task_id=new.task_id,
            account_id=new.account_id,
            platform=new.platform,
            message=new.message,
            error_type=new.error_type,
            created_at=new.created_at,
        )


class InMemoryInterventionHub:
    """内存事件存储：pending 列表供前端轮询消费，acknowledge 后出列。

    线程安全（server 的 ThreadingHTTPServer 每请求在独立线程）。
    """

    def __init__(self) -> None:
        self._items: dict[int, HumanIntervention] = {}
        self._next_id = 1
        self._lock = threading.Lock()

    def notify(self, new: NewIntervention) -> HumanIntervention:
        with self._lock:
            intervention = HumanIntervention(
                id=self._next_id,
                kind=new.kind,
                job_id=new.job_id,
                task_id=new.task_id,
                account_id=new.account_id,
                platform=new.platform,
                message=new.message,
                error_type=new.error_type,
                created_at=new.created_at or now_str(),
            )
            self._items[self._next_id] = intervention
            self._next_id += 1
            return intervention

    def pending(self) -> list[HumanIntervention]:
        """未处理（未 acknowledge）的事件，按产生顺序。"""
        with self._lock:
            return [
                iv
                for iv in self._items.values()
                if iv.acknowledged_at is None
            ]

    def acknowledge(self, intervention_id: int, now: str | None = None) -> bool:
        """标记事件已处理（前端弹窗后调用），返回是否真的 ack 到。"""
        with self._lock:
            iv = self._items.get(intervention_id)
            if iv is None or iv.acknowledged_at is not None:
                return False
            self._items[intervention_id] = HumanIntervention(
                id=iv.id,
                kind=iv.kind,
                job_id=iv.job_id,
                task_id=iv.task_id,
                account_id=iv.account_id,
                platform=iv.platform,
                message=iv.message,
                error_type=iv.error_type,
                created_at=iv.created_at,
                acknowledged_at=now or now_str(),
            )
            return True
