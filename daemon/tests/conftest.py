"""pytest 全局夹具：保证 `import conf` / `import posthub` 可用（daemon 根目录入 sys.path）。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


from types import SimpleNamespace  # noqa: E402

from posthub.tasks import PlatformJob  # noqa: E402

T0 = "2026-08-08 00:00:00"


def make_job(status: str = "pending", *, attempt_count: int = 0, **kw) -> PlatformJob:
    """一个 PlatformJob，可按需覆盖字段（tests 共享默认基座）。"""
    return PlatformJob(
        id=kw.pop("id", 1),
        task_id=kw.pop("task_id", 1),
        account_id=kw.pop("account_id", 1),
        platform=kw.pop("platform", "douyin"),  # type: ignore[arg-type]
        status=kw.pop("status", status),
        schedule_policy=kw.pop("schedule_policy", None),
        publish_mode=kw.pop("publish_mode", None),
        publish_at=kw.pop("publish_at", None),
        retry_at=kw.pop("retry_at", None),
        title=kw.pop("title", None),
        caption=kw.pop("caption", None),
        tags=kw.pop("tags", None),
        cover_horizontal=kw.pop("cover_horizontal", None),
        cover_vertical=kw.pop("cover_vertical", None),
        platform_fields=kw.pop("platform_fields", None),
        post_id=kw.pop("post_id", None),
        post_url=kw.pop("post_url", None),
        attempt_count=kw.pop("attempt_count", attempt_count),
        last_error=kw.pop("last_error", None),
        last_error_type=kw.pop("last_error_type", None),
        locked_at=kw.pop("locked_at", None),
        locked_by=kw.pop("locked_by", None),
        created_at=kw.pop("created_at", T0),
        started_at=kw.pop("started_at", None),
        finished_at=kw.pop("finished_at", None),
        updated_at=kw.pop("updated_at", T0),
        **kw,  # 剩余 kwargs 直接透传（如尝试覆盖 platform / 未知字段会由 dataclass 报错）
    )


def make_task(
    publish_mode: str = "platform_time", publish_at: str | None = None
) -> SimpleNamespace:
    """task 排期上下文（rules 只消费 publish_mode / publish_at，鸭子类型即可）。"""
    return SimpleNamespace(publish_mode=publish_mode, publish_at=publish_at)
