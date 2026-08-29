"""PostHub-owned scheduled 发布记录与日期范围查询。"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Mapping
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any

from flask import Flask, g, jsonify, request

from posthub import publish_adapter
from posthub.publish_adapter import EffectiveBatchItem

_RECORD_SERVICE_MARKER = "_posthub_publish_record_service"
_PLATFORM_NAMES = {
    1: "xiaohongshu",
    2: "wechat",
    3: "douyin",
    4: "kuaishou",
}


def _local_now() -> datetime:
    return publish_adapter._local_naive_now()


def _item_key(item: EffectiveBatchItem) -> tuple[Any, ...]:
    return (
        item.source_index,
        item.account_snapshot.account_id,
        tuple(item.effective.get("fileList", [])),
    )


def _format_local_datetime(value: datetime) -> str:
    if value.tzinfo is not None:
        raise ValueError("发布时间必须是本地 naive datetime")
    return value.isoformat(sep=" ", timespec="seconds")


def _parse_publish_datetimes(raw: Any) -> list[datetime] | None:
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise TypeError("publishDatetimes 必须是数组")
    values: list[datetime] = []
    for item in raw:
        if not isinstance(item, str):
            raise TypeError("publishDatetimes 必须是 ISO 时间字符串数组")
        value = datetime.fromisoformat(item)
        if value.tzinfo is not None:
            raise ValueError("publishDatetimes 不支持带时区时间")
        values.append(value)
    return values


def _parse_daily_time(raw: Any) -> time:
    if isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw <= 23:
        return time(raw)
    if not isinstance(raw, str):
        raise TypeError("dailyTimes 必须是 HH:MM 字符串数组")
    value = time.fromisoformat(raw)
    if value.second or value.microsecond:
        raise ValueError("dailyTimes 只支持 HH:MM")
    return value


def _scheduled_datetimes(
    effective: Mapping[str, Any], *, now: datetime
) -> list[datetime]:
    files = effective.get("fileList")
    if not isinstance(files, list) or not files:
        raise ValueError("scheduled item 缺少 fileList")

    persisted = _parse_publish_datetimes(effective.get("publishDatetimes"))
    if persisted is not None:
        if len(persisted) < len(files):
            raise ValueError("publishDatetimes 数量少于素材数量")
        return persisted[: len(files)]

    daily_times = effective.get("dailyTimes")
    if not isinstance(daily_times, (list, tuple)) or not daily_times:
        raise ValueError("scheduled item 缺少 dailyTimes")
    slots = [_parse_daily_time(value) for value in daily_times]
    videos_per_day = effective.get("videosPerDay")
    start_days = effective.get("startDays")
    if (
        isinstance(videos_per_day, bool)
        or not isinstance(videos_per_day, int)
        or videos_per_day <= 0
        or videos_per_day > len(slots)
    ):
        raise ValueError("scheduled item 的 videosPerDay 非法")
    if isinstance(start_days, bool) or not isinstance(start_days, int) or start_days < 0:
        raise ValueError("scheduled item 的 startDays 非法")
    return [
        datetime.combine(
            now.date() + timedelta(days=start_days + index // videos_per_day + 1),
            slots[index % videos_per_day],
        )
        for index in range(len(files))
    ]


class PublishRecordStore:
    """独立 posthub-runs.db 中的发布记录持久化边界。"""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS publish_record (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    account_file TEXT NOT NULL,
                    account_name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    video_title TEXT NOT NULL,
                    scheduled_for TEXT NOT NULL,
                    effective_scheduled_for TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('scheduled','published','failed','canceled')),
                    published_at TEXT,
                    run_id TEXT,
                    run_item_id TEXT,
                    recorded_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_record_account_date
                    ON publish_record(account_id, effective_scheduled_for);
                CREATE INDEX IF NOT EXISTS idx_record_date
                    ON publish_record(effective_scheduled_for);
                """
            )
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(publish_record)").fetchall()
            }
            if "published_at" not in columns:
                conn.execute("ALTER TABLE publish_record ADD COLUMN published_at TEXT")

    @staticmethod
    def _record_json(row: sqlite3.Row) -> dict[str, Any]:
        effective = row["effective_scheduled_for"]
        return {
            "id": row["id"],
            "accountId": row["account_id"],
            "accountFile": row["account_file"],
            "accountName": row["account_name"],
            "platform": row["platform"],
            "videoId": row["video_id"],
            "videoTitle": row["video_title"],
            "effectiveScheduledFor": effective,
            "scheduledFor": row["scheduled_for"],
            "status": row["status"],
            "publishedAt": row["published_at"],
            "runId": row["run_id"],
            "runItemId": row["run_item_id"],
            "recordedAt": row["recorded_at"],
        }

    def record_scheduled_items(
        self,
        items: Iterable[EffectiveBatchItem],
        *,
        scheduled_at: datetime | None = None,
        run_id: str | None = None,
        run_item_ids: Iterable[str | None] | None = None,
    ) -> list[dict[str, Any]]:
        """记录成功受理的 scheduled effective item；失败请求不应调用本方法。"""
        snapshot_now = _local_now() if scheduled_at is None else scheduled_at
        if snapshot_now.tzinfo is not None:
            raise ValueError("scheduled_at 必须是本地 naive datetime")
        item_list = list(items)
        item_id_list = list(run_item_ids or [])
        recorded_at = _format_local_datetime(_local_now())
        values: list[tuple[Any, ...]] = []
        for item_index, item in enumerate(item_list):
            effective = item.effective
            if not effective.get("enableTimer"):
                continue
            account = item.account_snapshot
            platform = _PLATFORM_NAMES[item.platform_type]
            datetimes = _scheduled_datetimes(effective, now=snapshot_now)
            files = effective["fileList"]
            title = effective.get("title")
            if not isinstance(title, str) or not title:
                raise ValueError("scheduled item 缺少标题")
            item_id = item_id_list[item_index] if item_index < len(item_id_list) else None
            for file_path, scheduled_for in zip(files, datetimes, strict=True):
                formatted = _format_local_datetime(scheduled_for)
                values.append(
                    (
                        account.account_id,
                        account.file_path,
                        account.user_name,
                        platform,
                        file_path,
                        title,
                        formatted,
                        formatted,
                        "scheduled",
                        None,
                        run_id,
                        item_id,
                        recorded_at,
                    )
                )

        if not values:
            return []
        with self._connect() as conn:
            ids: list[int] = []
            for value in values:
                cursor = conn.execute(
                    """
                    INSERT INTO publish_record
                      (account_id, account_file, account_name, platform, video_id,
                       video_title, scheduled_for, effective_scheduled_for, status,
                       published_at, run_id, run_item_id, recorded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    value,
                )
                ids.append(int(cursor.lastrowid))
            rows = conn.execute(
                f"SELECT * FROM publish_record WHERE id IN ({','.join('?' for _ in ids)}) ORDER BY id",
                ids,
            ).fetchall()
        return [self._record_json(row) for row in rows]

    def list_records(
        self, *, start_date: str | None = None, end_date: str | None = None
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[str] = []
        if start_date:
            clauses.append("effective_scheduled_for >= ?")
            params.append(f"{start_date} 00:00:00")
        if end_date:
            end = datetime.fromisoformat(end_date) + timedelta(days=1)
            clauses.append("effective_scheduled_for < ?")
            params.append(f"{end.date().isoformat()} 00:00:00")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM publish_record
                {where}
                ORDER BY effective_scheduled_for, account_id, id
                """,
                params,
            ).fetchall()
        return [self._record_json(row) for row in rows]


def _date_arg(*names: str) -> str | None:
    for name in names:
        value = request.args.get(name)
        if value:
            return value
    return None


def _validate_date(value: str | None, label: str) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value).date().isoformat()
    except ValueError as exc:
        raise ValueError(f"{label} 必须是 YYYY-MM-DD") from exc


def register_publish_record_routes(app: Flask, run_db_path: Path | str) -> PublishRecordStore:
    """注册记录查询路由，并在官方 timer 请求成功后写入快照。"""
    existing = app.extensions.get(_RECORD_SERVICE_MARKER)
    if existing is not None:
        return existing["store"]

    store = PublishRecordStore(run_db_path)

    def persist_one_success(item: EffectiveBatchItem) -> None:
        """在官方 wrapper 的单 item 成功边界写入记录。"""
        if not item.effective.get("enableTimer"):
            return
        try:
            store.record_scheduled_items(
                [item],
                scheduled_at=getattr(g, "posthub_schedule_snapshot_at", None),
            )
            recorded = getattr(g, "posthub_recorded_effective_keys", set())
            recorded.add(_item_key(item))
            g.posthub_recorded_effective_keys = recorded
        except Exception:
            # 记录落库失败不应把已成功提交的平台动作伪装成失败。
            app.logger.exception(
                "scheduled 发布记录写入失败：account=%s files=%s",
                item.account_snapshot.file_path,
                item.effective.get("fileList"),
            )

    @app.before_request
    def prepare_publish_record_context():
        if request.endpoint not in {"postVideo", "postVideoBatch"}:
            return
        g.posthub_schedule_snapshot_at = _local_now()
        g.posthub_recorded_effective_keys = set()
        g.posthub_record_effective_success = persist_one_success

    @app.get("/publishRecords")
    @app.get("/posthub/publishRecords")
    def get_publish_records():
        try:
            start_date = _validate_date(_date_arg("from", "startDate", "start"), "from")
            end_date = _validate_date(_date_arg("to", "endDate", "end"), "to")
            if start_date and end_date and start_date > end_date:
                raise ValueError("from 不能晚于 to")
            data = store.list_records(start_date=start_date, end_date=end_date)
        except (ValueError, sqlite3.Error) as exc:
            return jsonify({"code": 400, "msg": str(exc), "data": None}), 400
        return jsonify({"code": 200, "msg": None, "data": data}), 200

    @app.after_request
    def persist_successful_scheduled_records(response):
        if response.status_code != 200:
            return response
        normalized = getattr(g, "posthub_normalized_batch", None)
        if normalized is None:
            return response
        recorded = getattr(g, "posthub_recorded_effective_keys", set())
        remaining = [
            item for item in normalized.effective if _item_key(item) not in recorded
        ]
        if remaining:
            try:
                store.record_scheduled_items(
                    remaining,
                    scheduled_at=getattr(g, "posthub_schedule_snapshot_at", None),
                )
            except Exception:
                # 记录写入失败不能伪装成无记录；保留响应并让日志/后续诊断处理。
                app.logger.exception("scheduled 发布记录写入失败")
        return response

    app.extensions[_RECORD_SERVICE_MARKER] = {"store": store}
    return store
