"""PostHub-owned scheduled 发布记录与日期范围查询。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Iterable, Mapping
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any

from flask import Flask, g, jsonify, request

from posthub import publish_adapter
from posthub.publish_adapter import (
    EffectiveBatchItem,
    NormalizationError,
    normalize_publish_payloads,
)

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


def publish_fingerprint(
    platform: str, account_id: int, account_file: str, video_id: str
) -> str:
    """生成只依赖视频与账号身份的稳定历史指纹。"""
    canonical = json.dumps(
        [platform, account_id, account_file, video_id],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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
    if (
        isinstance(start_days, bool)
        or not isinstance(start_days, int)
        or start_days < 0
    ):
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
                    scheduled_for TEXT,
                    effective_scheduled_for TEXT,
                    status TEXT NOT NULL CHECK (status IN ('scheduled','published','failed','canceled')),
                    published_at TEXT,
                    run_id TEXT,
                    run_item_id TEXT,
                    recorded_at TEXT NOT NULL,
                    fingerprint TEXT
                );
                """
            )
            columns = {
                row[1]: row
                for row in conn.execute("PRAGMA table_info(publish_record)").fetchall()
            }
            schedule_is_not_null = any(
                columns.get(name, (None,) * 4)[3] == 1
                for name in ("scheduled_for", "effective_scheduled_for")
            )
            if (
                "scheduled_for" not in columns
                or "effective_scheduled_for" not in columns
                or schedule_is_not_null
            ):
                # SQLite 不能直接移除 NOT NULL；重建时保留旧历史和主键。
                conn.executescript(
                    """
                    DROP INDEX IF EXISTS idx_record_account_date;
                    DROP INDEX IF EXISTS idx_record_date;
                    DROP INDEX IF EXISTS idx_record_fingerprint;
                    ALTER TABLE publish_record RENAME TO publish_record_old;
                    CREATE TABLE publish_record (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_id INTEGER NOT NULL,
                        account_file TEXT NOT NULL,
                        account_name TEXT NOT NULL,
                        platform TEXT NOT NULL,
                        video_id TEXT NOT NULL,
                        video_title TEXT NOT NULL,
                        scheduled_for TEXT,
                        effective_scheduled_for TEXT,
                        status TEXT NOT NULL CHECK (status IN ('scheduled','published','failed','canceled')),
                        published_at TEXT,
                        run_id TEXT,
                        run_item_id TEXT,
                        recorded_at TEXT NOT NULL,
                        fingerprint TEXT
                    );
                    """
                )
                old = {
                    row[1]
                    for row in conn.execute(
                        "PRAGMA table_info(publish_record_old)"
                    ).fetchall()
                }
                names = (
                    "id, account_id, account_file, account_name, platform, video_id, "
                    "video_title, scheduled_for, effective_scheduled_for, status, "
                    "published_at, run_id, run_item_id, recorded_at, fingerprint"
                )
                expressions = {
                    "scheduled_for": "scheduled_for"
                    if "scheduled_for" in old
                    else "NULL",
                    "effective_scheduled_for": (
                        "effective_scheduled_for"
                        if "effective_scheduled_for" in old
                        else "NULL"
                    ),
                    "published_at": "published_at" if "published_at" in old else "NULL",
                    "run_id": "run_id" if "run_id" in old else "NULL",
                    "run_item_id": "run_item_id" if "run_item_id" in old else "NULL",
                    "fingerprint": "fingerprint" if "fingerprint" in old else "NULL",
                }
                conn.execute(
                    f"""
                    INSERT INTO publish_record ({names})
                    SELECT id, account_id, account_file, account_name, platform,
                           video_id, video_title, {expressions["scheduled_for"]},
                           {expressions["effective_scheduled_for"]}, status,
                           {expressions["published_at"]}, {expressions["run_id"]},
                           {expressions["run_item_id"]}, recorded_at,
                           {expressions["fingerprint"]}
                    FROM publish_record_old
                    """
                )
                conn.execute("DROP TABLE publish_record_old")
            elif "published_at" not in columns:
                conn.execute("ALTER TABLE publish_record ADD COLUMN published_at TEXT")
            if "fingerprint" not in {
                row[1]
                for row in conn.execute("PRAGMA table_info(publish_record)").fetchall()
            }:
                conn.execute("ALTER TABLE publish_record ADD COLUMN fingerprint TEXT")

            rows = conn.execute(
                """
                SELECT id, platform, account_id, account_file, video_id
                FROM publish_record WHERE fingerprint IS NULL
                """
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE publish_record SET fingerprint = ? WHERE id = ?",
                    (
                        publish_fingerprint(
                            row["platform"],
                            row["account_id"],
                            row["account_file"],
                            row["video_id"],
                        ),
                        row["id"],
                    ),
                )
            conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_record_account_date
                    ON publish_record(account_id, effective_scheduled_for, published_at);
                CREATE INDEX IF NOT EXISTS idx_record_date
                    ON publish_record(effective_scheduled_for, published_at);
                CREATE INDEX IF NOT EXISTS idx_record_fingerprint
                    ON publish_record(fingerprint, status);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_record_run_item_video
                    ON publish_record(run_id, run_item_id, video_id)
                    WHERE run_id IS NOT NULL AND run_item_id IS NOT NULL;
                """
            )

    @staticmethod
    def _record_json(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "accountId": row["account_id"],
            "accountFile": row["account_file"],
            "accountName": row["account_name"],
            "platform": row["platform"],
            "videoId": row["video_id"],
            "videoTitle": row["video_title"],
            "effectiveScheduledFor": row["effective_scheduled_for"],
            "scheduledFor": row["scheduled_for"],
            "status": row["status"],
            "publishedAt": row["published_at"],
            "runId": row["run_id"],
            "runItemId": row["run_item_id"],
            "recordedAt": row["recorded_at"],
        }

    def _insert_records(
        self,
        values: list[tuple[Any, ...]],
        *,
        run_id: str | None,
        run_item_id: str | None,
    ) -> list[dict[str, Any]]:
        if not values:
            return []
        with self._connect() as conn:
            ids: list[int] = []
            for value in values:
                video_id = value[4]
                if run_id is not None and run_item_id is not None:
                    existing = conn.execute(
                        """
                        SELECT id FROM publish_record
                        WHERE run_id = ? AND run_item_id = ? AND video_id = ?
                        """,
                        (run_id, run_item_id, video_id),
                    ).fetchone()
                    if existing is not None:
                        ids.append(int(existing["id"]))
                        continue
                cursor = conn.execute(
                    """
                    INSERT INTO publish_record
                      (account_id, account_file, account_name, platform, video_id,
                       video_title, scheduled_for, effective_scheduled_for, status,
                       published_at, run_id, run_item_id, recorded_at, fingerprint)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    value,
                )
                ids.append(int(cursor.lastrowid))
            rows = conn.execute(
                f"SELECT * FROM publish_record WHERE id IN ({','.join('?' for _ in ids)}) ORDER BY id",
                ids,
            ).fetchall()
        return [self._record_json(row) for row in rows]

    def record_successful_payload(
        self,
        effective: Mapping[str, Any],
        *,
        account_id: int,
        account_file: str,
        account_name: str,
        platform: str,
        published_at: datetime | None = None,
        scheduled_at: datetime | None = None,
        run_id: str | None = None,
        run_item_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """记录一个已成功执行的 effective payload，按素材粒度展开。"""
        files = effective.get("fileList")
        title = effective.get("title")
        if (
            not isinstance(files, list)
            or not files
            or any(not isinstance(file, str) or not file for file in files)
        ):
            raise ValueError("成功 item 缺少合法 fileList")
        if not isinstance(title, str) or not title:
            raise ValueError("成功 item 缺少标题")
        snapshot = published_at or scheduled_at or _local_now()
        if snapshot.tzinfo is not None:
            raise ValueError("发布时间必须是本地 naive datetime")
        recorded_at = _format_local_datetime(_local_now())
        is_scheduled = bool(effective.get("enableTimer"))
        datetimes = (
            _scheduled_datetimes(effective, now=scheduled_at or snapshot)
            if is_scheduled
            else []
        )
        values: list[tuple[Any, ...]] = []
        for index, file_path in enumerate(files):
            scheduled_value = (
                _format_local_datetime(datetimes[index]) if is_scheduled else None
            )
            effective_value = scheduled_value
            published_value = None if is_scheduled else _format_local_datetime(snapshot)
            values.append(
                (
                    account_id,
                    account_file,
                    account_name,
                    platform,
                    file_path,
                    title,
                    scheduled_value,
                    effective_value,
                    "scheduled" if is_scheduled else "published",
                    published_value,
                    run_id,
                    run_item_id,
                    recorded_at,
                    publish_fingerprint(platform, account_id, account_file, file_path),
                )
            )
        return self._insert_records(values, run_id=run_id, run_item_id=run_item_id)

    def record_successful_items(
        self,
        items: Iterable[EffectiveBatchItem],
        *,
        scheduled_at: datetime | None = None,
        run_id: str | None = None,
        run_item_ids: Iterable[str | None] | None = None,
    ) -> list[dict[str, Any]]:
        """记录 wrapper 已成功执行的 effective items（立即或定时）。"""
        item_list = list(items)
        item_id_list = list(run_item_ids or [])
        records: list[dict[str, Any]] = []
        snapshot = _local_now() if scheduled_at is None else scheduled_at
        for index, item in enumerate(item_list):
            account = item.account_snapshot
            records.extend(
                self.record_successful_payload(
                    item.effective,
                    account_id=account.account_id,
                    account_file=account.file_path,
                    account_name=account.user_name,
                    platform=_PLATFORM_NAMES[item.platform_type],
                    published_at=snapshot,
                    scheduled_at=snapshot,
                    run_id=run_id,
                    run_item_id=item_id_list[index]
                    if index < len(item_id_list)
                    else None,
                )
            )
        return records

    def record_scheduled_items(
        self,
        items: Iterable[EffectiveBatchItem],
        *,
        scheduled_at: datetime | None = None,
        run_id: str | None = None,
        run_item_ids: Iterable[str | None] | None = None,
    ) -> list[dict[str, Any]]:
        """兼容旧调用名；记录 wrapper 成功的立即/定时 item。"""
        return self.record_successful_items(
            items,
            scheduled_at=scheduled_at,
            run_id=run_id,
            run_item_ids=run_item_ids,
        )

    def find_successful_duplicates(
        self, items: Iterable[EffectiveBatchItem | Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        """按 fingerprint 查询历史 published 记录，不读取 scheduled/failed。"""
        fingerprints: list[str] = []
        for item in items:
            if isinstance(item, EffectiveBatchItem):
                account = item.account_snapshot
                platform = _PLATFORM_NAMES[item.platform_type]
                files = item.effective.get("fileList", [])
                account_id, account_file = account.account_id, account.file_path
            else:
                platform = item.get("platform")
                if not isinstance(platform, str):
                    platform = _PLATFORM_NAMES.get(item.get("type"))
                account_id = item.get("accountId")
                account_file = item.get("accountFile")
                files = item.get("fileList", [])
                if not isinstance(account_id, int) or not isinstance(account_file, str):
                    continue
            if not isinstance(platform, str) or not isinstance(account_id, int):
                continue
            if not isinstance(account_file, str) or not isinstance(files, list):
                continue
            fingerprints.extend(
                publish_fingerprint(platform, account_id, account_file, file_path)
                for file_path in files
                if isinstance(file_path, str)
            )
        if not fingerprints:
            return []
        with self._connect() as conn:
            placeholders = ",".join("?" for _ in set(fingerprints))
            rows = conn.execute(
                f"""
                SELECT * FROM publish_record
                WHERE status = 'published' AND fingerprint IN ({placeholders})
                ORDER BY published_at, id
                """,
                list(dict.fromkeys(fingerprints)),
            ).fetchall()
        return [self._record_json(row) for row in rows]

    def list_records(
        self, *, start_date: str | None = None, end_date: str | None = None
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[str] = []
        display_time = "COALESCE(effective_scheduled_for, published_at)"
        if start_date:
            clauses.append(f"{display_time} >= ?")
            params.append(f"{start_date} 00:00:00")
        if end_date:
            end = datetime.fromisoformat(end_date) + timedelta(days=1)
            clauses.append(f"{display_time} < ?")
            params.append(f"{end.date().isoformat()} 00:00:00")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM publish_record
                {where}
                ORDER BY {display_time}, account_id, id
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


def register_publish_record_routes(
    app: Flask,
    run_db_path: Path | str,
    official_db_path: Path | str | None = None,
) -> PublishRecordStore:
    """注册记录查询路由、重复预检，并写入成功发布快照。"""
    existing = app.extensions.get(_RECORD_SERVICE_MARKER)
    if existing is not None:
        return existing["store"]

    store = PublishRecordStore(run_db_path)

    def persist_one_success(item: EffectiveBatchItem) -> None:
        """在官方 wrapper 的单 item 成功边界写入立即/定时记录。"""
        try:
            store.record_successful_items(
                [item],
                scheduled_at=getattr(g, "posthub_schedule_snapshot_at", None),
            )
            recorded = getattr(g, "posthub_recorded_effective_keys", set())
            recorded.add(_item_key(item))
            g.posthub_recorded_effective_keys = recorded
        except Exception:
            # 记录落库失败不应把已成功提交的平台动作伪装成失败。
            app.logger.exception(
                "发布记录写入失败：account=%s files=%s",
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

    def duplicate_records_for_payload(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, dict):
            payloads = [payload]
        elif isinstance(payload, list) and payload:
            payloads = payload
        else:
            raise ValueError("item 必须是 object 或非空数组")
        if any(not isinstance(item, dict) for item in payloads):
            raise ValueError("每个 item 必须是 object")
        from posthub.routes import _read_publish_account_rows

        account_db = (
            Path(official_db_path)
            if official_db_path is not None
            else Path(run_db_path)
        )
        normalized = normalize_publish_payloads(
            payloads, _read_publish_account_rows(account_db)
        )
        return store.find_successful_duplicates(normalized.effective)

    @app.post("/publishRecords/check")
    @app.post("/posthub/publishRecords/check")
    def check_publish_records():
        payload = request.get_json(silent=True)
        try:
            duplicates = duplicate_records_for_payload(payload)
        except (NormalizationError, ValueError, sqlite3.Error) as exc:
            return jsonify({"code": 400, "msg": str(exc), "data": None}), 400
        return jsonify(
            {
                "code": 200,
                "msg": None,
                "data": {"duplicates": duplicates},
            }
        ), 200

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

    app.extensions[_RECORD_SERVICE_MARKER] = {
        "store": store,
        "record_effective_success": persist_one_success,
    }
    return store
