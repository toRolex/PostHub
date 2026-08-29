"""PostHub-owned accepted-run 观察与受限 retry 主干。

该模块只保存本机 run/item 记录并驱动可替换的 uploader；不替代官方
发布执行，也不实现通用 scheduler、限速或并发策略。retry 只复制首次
受理时冻结的 effective payload。
"""

from __future__ import annotations

import json
import logging
import math
import multiprocessing
import os
import signal
import sqlite3
import subprocess
import threading
import time
import traceback
import uuid
from collections import Counter
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from posthub.publish_adapter import (
    EffectiveBatchItem,
    NormalizationError,
    normalize_publish_payloads,
)

_RUN_ROUTE_MARKER = "_posthub_run_routes_registered"
_RUN_SERVICE_MARKER = "_posthub_run_service"
DEFAULT_LEASE_SECONDS = 300.0
DEFAULT_STOP_TIMEOUT = 1.0
DEFAULT_ITEM_TIMEOUT_SECONDS = 300.0
ITEM_TIMEOUT_ENV = "POSTHUB_ITEM_TIMEOUT_SECONDS"
FAIL_CLOSED_ERROR = "未配置 immediate 发布执行器；生产组合必须注入真实官方执行 seam"
logger = logging.getLogger(__name__)


def configured_item_timeout_seconds() -> float:
    """读取受控的单 item 超时配置；未配置时使用 300 秒。"""
    raw = os.environ.get(ITEM_TIMEOUT_ENV)
    if raw is None:
        return DEFAULT_ITEM_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{ITEM_TIMEOUT_ENV} 必须是正数") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{ITEM_TIMEOUT_ENV} 必须是正数")
    return value


LEASE_LOST_ERROR = "item lease 已失效，跳过外部执行"
RETRYABLE_ITEM_STATUSES = frozenset({"failed", "skipped", "interrupted"})
TERMINAL_ITEM_STATUSES = frozenset({"success", "failed", "skipped", "interrupted"})


class DuplicateSubmissionError(ValueError):
    """同一受理请求内包含重复的视频×账号组合。"""


class ActiveRunConflict(RuntimeError):
    """视频×账号已被另一个尚未结束的 run 占用。"""

    def __init__(self, existing_run_id: str, description: str) -> None:
        self.existing_run_id = existing_run_id
        super().__init__(f"已有相同视频×账号的运行正在执行：{description}")


def _dedupe_key(effective: Mapping[str, Any]) -> tuple[str, str, str]:
    file_list = effective.get("fileList")
    account_list = effective.get("accountList")
    if (
        not isinstance(file_list, list)
        or len(file_list) != 1
        or not isinstance(file_list[0], str)
        or not isinstance(account_list, list)
        or len(account_list) != 1
        or not isinstance(account_list[0], str)
    ):
        raise ValueError("effective item 必须恰好包含一个视频和一个账号")
    file_path = file_list[0]
    account_path = account_list[0]
    return (
        json.dumps(
            [file_path, account_path], ensure_ascii=False, separators=(",", ":")
        ),
        file_path,
        account_path,
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _lease_until(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=max(0.0, seconds))).isoformat(
        timespec="milliseconds"
    )


def _error_summary(error: str | None) -> str | None:
    if error is None:
        return None
    if error == "":
        return ""
    # 某些上游异常把换行编码成两个字符 ``\\n``，摘要仍只取首行。
    return error.replace("\\n", "\n").splitlines()[0][:160]


class RunStore:
    """独立 SQLite 中的 run/item 最小持久化边界。"""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_failures', 'interrupted')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    parent_run_id TEXT
                );
                CREATE TABLE IF NOT EXISTS run_items (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped', 'interrupted')),
                    submitted_json TEXT NOT NULL,
                    effective_json TEXT NOT NULL,
                    error TEXT,
                    error_summary TEXT,
                    error_detail TEXT,
                    diagnostics_json TEXT NOT NULL DEFAULT '[]',
                    dedupe_key TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    lease_owner TEXT,
                    lease_until TEXT,
                    source_item_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_run_items_status ON run_items(status);
                """
            )
            runs_sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'"
            ).fetchone()[0]
            items_sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_items'"
            ).fetchone()[0]
            run_columns = {
                row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()
            }
            if (
                "completed_with_failures" not in runs_sql
                or "interrupted" not in runs_sql
                or "parent_run_id" not in run_columns
                or "skipped" not in items_sql
                or "interrupted" not in items_sql
                or "source_item_id"
                not in {
                    row[1]
                    for row in conn.execute("PRAGMA table_info(run_items)").fetchall()
                }
            ):
                self._migrate_runs_table(conn)

            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(run_items)").fetchall()
            }
            if "error_summary" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN error_summary TEXT")
            if "error_detail" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN error_detail TEXT")
            if "lease_owner" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN lease_owner TEXT")
            if "lease_until" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN lease_until TEXT")
            if "diagnostics_json" not in columns:
                conn.execute(
                    "ALTER TABLE run_items ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "dedupe_key" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN dedupe_key TEXT")
            legacy_items = conn.execute(
                """
                SELECT id, effective_json, status, dedupe_key
                FROM run_items
                WHERE dedupe_key IS NULL OR status IN ('pending', 'running')
                ORDER BY created_at, ordinal, id
                """
            ).fetchall()
            active_keys: set[str] = set()
            for row in legacy_items:
                try:
                    key, file_path, account_path = _dedupe_key(
                        json.loads(row["effective_json"])
                    )
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if row["status"] in {"pending", "running"} and key in active_keys:
                    migration_error = (
                        "数据库迁移发现重复活动视频×账号，已隔离 item："
                        f"{file_path} × {account_path}"
                    )
                    conn.execute(
                        """
                        UPDATE run_items
                        SET status = 'failed', error = ?, error_summary = ?,
                            error_detail = ?, dedupe_key = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            migration_error,
                            migration_error,
                            migration_error,
                            key,
                            _now(),
                            row["id"],
                        ),
                    )
                    continue
                if row["dedupe_key"] != key:
                    conn.execute(
                        "UPDATE run_items SET dedupe_key = ? WHERE id = ?",
                        (key, row["id"]),
                    )
                if row["status"] in {"pending", "running"}:
                    active_keys.add(key)
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_run_items_active_dedupe
                ON run_items(dedupe_key)
                WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running')
                """
            )
            legacy_errors = conn.execute(
                """
                SELECT id, error FROM run_items
                WHERE error IS NOT NULL AND error_summary IS NULL
                """
            ).fetchall()
            for row in legacy_errors:
                conn.execute(
                    "UPDATE run_items SET error_summary = ? WHERE id = ?",
                    (_error_summary(row["error"]), row["id"]),
                )
            conn.execute(
                """
                UPDATE run_items
                SET error_detail = error
                WHERE error IS NOT NULL AND error_detail IS NULL
                """
            )
            # 旧版本会把含失败 item 的 run 误记为 completed；崩溃恢复也
            # 可能遗留没有活动 item 的 running。首次打开时按 item 事实纠正，
            # 避免历史详情继续显示为“已完成”或永久轮询“执行中”。
            conn.execute(
                """
                UPDATE runs
                SET status = 'completed_with_failures'
                WHERE status = 'completed'
                  AND EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id AND run_items.status IN ('failed', 'skipped', 'interrupted')
                  )
                """
            )
            conn.execute(
                """
                UPDATE runs
                SET status = CASE WHEN EXISTS (
                        SELECT 1 FROM run_items
                        WHERE run_items.run_id = runs.id AND run_items.status IN ('failed', 'skipped', 'interrupted')
                    ) THEN 'completed_with_failures' ELSE 'completed' END,
                    completed_at = COALESCE(completed_at, updated_at)
                WHERE status = 'running'
                  AND NOT EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id
                        AND run_items.status IN ('pending', 'running')
                  )
                """
            )

    @staticmethod
    def _migrate_runs_table(conn: sqlite3.Connection) -> None:
        """重建旧 runs/run_items，扩展正式状态与 retry 追溯列。"""
        run_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()
        }
        item_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(run_items)").fetchall()
        }
        run_parent = "parent_run_id" if "parent_run_id" in run_columns else "NULL"
        item_expressions = {
            name: name if name in item_columns else default
            for name, default in {
                "error_summary": "NULL",
                "error_detail": "NULL",
                "diagnostics_json": "'[]'",
                "dedupe_key": "NULL",
                "lease_owner": "NULL",
                "lease_until": "NULL",
                "source_item_id": "NULL",
            }.items()
        }
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE run_items RENAME TO run_items_old")
        conn.execute("ALTER TABLE runs RENAME TO runs_old")
        conn.executescript(
            """
            CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_failures', 'interrupted')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                parent_run_id TEXT
            );
            CREATE TABLE run_items (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped', 'interrupted')),
                submitted_json TEXT NOT NULL,
                effective_json TEXT NOT NULL,
                error TEXT,
                error_summary TEXT,
                error_detail TEXT,
                diagnostics_json TEXT NOT NULL DEFAULT '[]',
                dedupe_key TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                lease_owner TEXT,
                lease_until TEXT,
                source_item_id TEXT
            );
            """
        )
        conn.execute(
            f"""
            INSERT INTO runs (id, status, created_at, updated_at, completed_at, parent_run_id)
            SELECT id, status, created_at, updated_at, completed_at, {run_parent}
            FROM runs_old
            """
        )
        conn.execute(
            f"""
            INSERT INTO run_items
              (id, run_id, ordinal, status, submitted_json, effective_json, error,
               error_summary, error_detail, diagnostics_json, dedupe_key, created_at,
               updated_at, lease_owner, lease_until, source_item_id)
            SELECT id, run_id, ordinal, status, submitted_json, effective_json, error,
                   {item_expressions["error_summary"]}, {item_expressions["error_detail"]},
                   {item_expressions["diagnostics_json"]}, {item_expressions["dedupe_key"]},
                   created_at, updated_at, {item_expressions["lease_owner"]},
                   {item_expressions["lease_until"]}, {item_expressions["source_item_id"]}
            FROM run_items_old
            """
        )
        conn.execute("DROP TABLE run_items_old")
        conn.execute("DROP TABLE runs_old")
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_run_items_status ON run_items(status);
            """
        )
        conn.execute("PRAGMA foreign_keys = ON")

    def create_run(self, items: Iterable[EffectiveBatchItem]) -> str:
        effective_items = list(items)
        if not effective_items:
            raise ValueError("run 至少需要一个 item")

        dedupe_items: list[tuple[EffectiveBatchItem, str, str, str]] = []
        seen: set[str] = set()
        for item in effective_items:
            key, file_path, account_path = _dedupe_key(item.effective)
            if key in seen:
                raise DuplicateSubmissionError(
                    f"同一提交中存在重复视频×账号：{file_path} × {account_path}"
                )
            seen.add(key)
            dedupe_items.append((item, key, file_path, account_path))

        run_id = str(uuid.uuid4())
        now = _now()
        with self._lock, self._connect() as conn:
            # 进程内锁只保护同一 RunStore；跨连接的单飞行由 SQLite 事务与
            # partial unique index 共同保证，不能用内存锁替代。
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO runs (id, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)",
                (run_id, now, now),
            )
            for ordinal, (item, key, file_path, account_path) in enumerate(
                dedupe_items
            ):
                try:
                    conn.execute(
                        """
                        INSERT INTO run_items
                          (id, run_id, ordinal, status, submitted_json, effective_json,
                           dedupe_key, created_at, updated_at)
                        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
                        """,
                        (
                            str(uuid.uuid4()),
                            run_id,
                            ordinal,
                            json.dumps(item.submitted, ensure_ascii=False),
                            json.dumps(item.effective, ensure_ascii=False),
                            key,
                            now,
                            now,
                        ),
                    )
                except sqlite3.IntegrityError as err:
                    existing = conn.execute(
                        """
                        SELECT run_id FROM run_items
                        WHERE dedupe_key = ? AND status IN ('pending', 'running')
                        ORDER BY created_at, ordinal
                        LIMIT 1
                        """,
                        (key,),
                    ).fetchone()
                    if existing is None:
                        raise
                    raise ActiveRunConflict(
                        existing["run_id"], f"{file_path} × {account_path}"
                    ) from err
        return run_id

    def retry_run(
        self,
        parent_run_id: str,
        item_ids: Iterable[str] | None = None,
    ) -> str:
        """从旧 run 复制可重试 item，创建一个只回放 effective 的新 run。

        ``item_ids`` 省略时选择全部 failure/skipped/interrupted；传入时只从
        指定集合中选择这些状态。原 run 的 submitted/effective 与生命周期都
        不会被改写，新的 item 通过 source_item_id 建立追溯关系。
        """
        requested_ids: list[str] | None = None
        if item_ids is not None:
            requested_ids = list(item_ids)
            if not requested_ids or any(
                not isinstance(item_id, str) or not item_id for item_id in requested_ids
            ):
                raise ValueError("itemIds 必须是非空字符串数组")

        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            parent = conn.execute(
                "SELECT id FROM runs WHERE id = ?", (parent_run_id,)
            ).fetchone()
            if parent is None:
                raise LookupError("run 不存在")

            if requested_ids is None:
                rows = conn.execute(
                    """
                    SELECT id, ordinal, status, submitted_json, effective_json
                    FROM run_items WHERE run_id = ? ORDER BY ordinal
                    """,
                    (parent_run_id,),
                ).fetchall()
            else:
                placeholders = ",".join("?" for _ in requested_ids)
                rows = conn.execute(
                    f"""
                    SELECT id, ordinal, status, submitted_json, effective_json
                    FROM run_items
                    WHERE run_id = ? AND id IN ({placeholders})
                    ORDER BY ordinal
                    """,
                    (parent_run_id, *requested_ids),
                ).fetchall()
            selected = [row for row in rows if row["status"] in RETRYABLE_ITEM_STATUSES]
            if not selected:
                raise ValueError("没有可重试 item")

            run_id = str(uuid.uuid4())
            now = _now()
            conn.execute(
                """
                INSERT INTO runs
                  (id, status, created_at, updated_at, parent_run_id)
                VALUES (?, 'pending', ?, ?, ?)
                """,
                (run_id, now, now, parent_run_id),
            )
            for ordinal, row in enumerate(selected):
                effective = json.loads(row["effective_json"])
                key, file_path, account_path = _dedupe_key(effective)
                try:
                    conn.execute(
                        """
                        INSERT INTO run_items
                          (id, run_id, ordinal, status, submitted_json, effective_json,
                           dedupe_key, created_at, updated_at, source_item_id)
                        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(uuid.uuid4()),
                            run_id,
                            ordinal,
                            row["submitted_json"],
                            row["effective_json"],
                            key,
                            now,
                            now,
                            row["id"],
                        ),
                    )
                except sqlite3.IntegrityError as err:
                    existing = conn.execute(
                        """
                        SELECT run_id FROM run_items
                        WHERE dedupe_key = ? AND status IN ('pending', 'running')
                        ORDER BY created_at, ordinal
                        LIMIT 1
                        """,
                        (key,),
                    ).fetchone()
                    if existing is None:
                        raise
                    raise ActiveRunConflict(
                        existing["run_id"], f"{file_path} × {account_path}"
                    ) from err
        return run_id

    def reconcile_daemon_startup(self) -> None:
        """将上次 daemon 遗留的活动 item 收敛为 interrupted，不自动续跑。"""
        now = _now()
        with self._lock, self._connect() as conn:
            # 组合入口在新 worker 启动前调用此方法；此时所有活动 item
            # 都属于已退出 daemon，不能再沿用普通 lease recovery 的 pending 语义。
            conn.execute(
                """
                UPDATE runs
                SET status = 'interrupted', updated_at = ?, completed_at = ?
                WHERE EXISTS (
                    SELECT 1 FROM run_items
                    WHERE run_items.run_id = runs.id
                      AND run_items.status IN ('pending', 'running')
                )
                """,
                (now, now),
            )
            conn.execute(
                """
                UPDATE run_items
                SET status = 'interrupted', lease_owner = NULL, lease_until = NULL,
                    updated_at = ?
                WHERE status IN ('pending', 'running')
                """,
                (now,),
            )
            # 兼容历史上 run 已经是 running、但 item 全部落终态的数据库，
            # 不让启动后遗留一个永远执行中的聚合状态。
            conn.execute(
                """
                UPDATE runs
                SET status = CASE WHEN EXISTS (
                        SELECT 1 FROM run_items
                        WHERE run_items.run_id = runs.id
                          AND run_items.status IN ('failed', 'skipped', 'interrupted')
                    ) THEN 'completed_with_failures' ELSE 'completed' END,
                    updated_at = ?, completed_at = COALESCE(completed_at, ?)
                WHERE status IN ('pending', 'running')
                  AND NOT EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id
                        AND run_items.status IN ('pending', 'running')
                  )
                """,
                (now, now),
            )

    def recover_incomplete(self) -> None:
        """只回收 lease 已过期的 running item，保留仍由其他 worker 持有的 item。"""
        now = _now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE run_items
                SET status = 'pending', lease_owner = NULL, lease_until = NULL,
                    diagnostics_json = '[]', updated_at = ?
                WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)
                """,
                (now, now),
            )
            conn.execute(
                """
                UPDATE runs
                SET status = 'pending', updated_at = ?
                WHERE status = 'running'
                  AND NOT EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id AND run_items.status = 'running'
                  )
                  AND EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id AND run_items.status = 'pending'
                  )
                """,
                (now,),
            )
            conn.execute(
                """
                UPDATE runs
                SET status = CASE WHEN EXISTS (
                        SELECT 1 FROM run_items
                        WHERE run_items.run_id = runs.id AND run_items.status IN ('failed', 'skipped', 'interrupted')
                    ) THEN 'completed_with_failures' ELSE 'completed' END,
                    updated_at = ?, completed_at = COALESCE(completed_at, ?)
                WHERE status = 'running'
                  AND NOT EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id
                        AND run_items.status IN ('pending', 'running')
                  )
                """,
                (now, now),
            )

    def claim_next_item(
        self, owner_token: str, *, lease_seconds: float = DEFAULT_LEASE_SECONDS
    ) -> tuple[str, str, dict[str, Any]] | None:
        """原子领取一个 pending item，并把 lease 绑定到 worker owner。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        now = _now()
        lease_until = _lease_until(lease_seconds)
        with self._lock, self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT i.id, i.run_id, i.effective_json
                FROM run_items AS i
                JOIN runs AS r ON r.id = i.run_id
                WHERE i.status = 'pending' AND r.status IN ('pending', 'running')
                ORDER BY r.created_at, i.ordinal
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            updated = conn.execute(
                """
                UPDATE run_items
                SET status = 'running', lease_owner = ?, lease_until = ?,
                    diagnostics_json = '[]', updated_at = ?
                WHERE id = ? AND status = 'pending'
                """,
                (owner_token, lease_until, now, row["id"]),
            )
            if updated.rowcount != 1:
                return None
            conn.execute(
                "UPDATE runs SET status = 'running', updated_at = ? WHERE id = ?",
                (now, row["run_id"]),
            )
            return row["run_id"], row["id"], json.loads(row["effective_json"])

    def release_item(self, run_id: str, item_id: str, *, owner_token: str) -> bool:
        """在进入外部执行前安全释放 worker 自己领取的 item。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        now = _now()
        with self._lock, self._connect() as conn:
            released = conn.execute(
                """
                UPDATE run_items
                SET status = 'pending', lease_owner = NULL, lease_until = NULL,
                    diagnostics_json = '[]', updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (now, item_id, run_id, owner_token),
            )
            if released.rowcount != 1:
                return False
            conn.execute(
                """
                UPDATE runs SET status = 'pending', updated_at = ?
                WHERE id = ? AND status = 'running'
                  AND NOT EXISTS (
                      SELECT 1 FROM run_items
                      WHERE run_items.run_id = runs.id AND run_items.status = 'running'
                  )
                """,
                (now, run_id),
            )
            return True

    def renew_lease(
        self,
        run_id: str,
        item_id: str,
        *,
        owner_token: str,
        lease_seconds: float,
    ) -> bool:
        """在阻塞 uploader 执行期间续租，避免过期后被另一 worker 重复领取。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        now = _now()
        lease_until = _lease_until(lease_seconds)
        with self._lock, self._connect() as conn:
            updated = conn.execute(
                """
                UPDATE run_items
                SET lease_until = ?, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (lease_until, now, item_id, run_id, owner_token),
            )
            return updated.rowcount == 1

    def record_item_diagnostics(
        self,
        run_id: str,
        item_id: str,
        *,
        owner_token: str,
        diagnostics: Iterable[Mapping[str, Any]],
    ) -> bool:
        """持久化当前 worker 采集的 DOM warning/debug 诊断。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        payload = [dict(item) for item in diagnostics]
        with self._lock, self._connect() as conn:
            updated = conn.execute(
                """
                UPDATE run_items
                SET diagnostics_json = ?, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (
                    json.dumps(payload, ensure_ascii=False),
                    _now(),
                    item_id,
                    run_id,
                    owner_token,
                ),
            )
            return updated.rowcount == 1

    def finish_item(
        self,
        run_id: str,
        item_id: str,
        *,
        owner_token: str,
        error: str | None = None,
        error_summary: str | None = None,
        error_detail: str | None = None,
    ) -> bool:
        """仅允许持有当前 lease 的 worker 完成 item；返回是否完成。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        now = _now()
        status = "failed" if error is not None else "success"
        summary = error_summary if error_summary is not None else _error_summary(error)
        detail = error_detail if error_detail is not None else error
        with self._lock, self._connect() as conn:
            updated = conn.execute(
                """
                UPDATE run_items
                SET status = ?, error = ?, error_summary = ?, error_detail = ?,
                    lease_owner = NULL, lease_until = NULL, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (
                    status,
                    summary,
                    summary,
                    detail,
                    now,
                    item_id,
                    run_id,
                    owner_token,
                ),
            )
            if updated.rowcount != 1:
                return False
            remaining = conn.execute(
                """
                SELECT COUNT(*) FROM run_items
                WHERE run_id = ? AND status IN ('pending', 'running')
                """,
                (run_id,),
            ).fetchone()[0]
            if remaining == 0:
                failed = conn.execute(
                    """
                    SELECT COUNT(*) FROM run_items
                    WHERE run_id = ? AND status IN ('failed', 'skipped', 'interrupted')
                    """,
                    (run_id,),
                ).fetchone()[0]
                final_status = "completed_with_failures" if failed else "completed"
                conn.execute(
                    """
                    UPDATE runs SET status = ?, updated_at = ?, completed_at = ?
                    WHERE id = ?
                    """,
                    (final_status, now, now, run_id),
                )
            else:
                conn.execute(
                    "UPDATE runs SET updated_at = ? WHERE id = ?",
                    (now, run_id),
                )
            return True

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if run is None:
                return None
            items = conn.execute(
                """
                SELECT id, ordinal, status, error, error_summary, error_detail,
                       diagnostics_json, submitted_json, effective_json, source_item_id
                FROM run_items WHERE run_id = ? ORDER BY ordinal
                """,
                (run_id,),
            ).fetchall()
        counts = Counter(item["status"] for item in items)
        item_count = len(items)
        result: dict[str, Any] = {
            "runId": run["id"],
            "status": run["status"],
            "createdAt": run["created_at"],
            "updatedAt": run["updated_at"],
            "completedAt": run["completed_at"],
            # 汇总直接从持久化 run_items 计算，前端不需要根据本地提交列表猜测进度。
            "summary": {
                "itemCount": item_count,
                "pendingCount": counts["pending"],
                "runningCount": counts["running"],
                "successCount": counts["success"],
                "failedCount": counts["failed"],
                "completedCount": sum(
                    counts[status] for status in TERMINAL_ITEM_STATUSES
                ),
            },
            "items": [],
        }
        if run["parent_run_id"] is not None:
            result["parentRunId"] = run["parent_run_id"]
        for item in items:
            item_result: dict[str, Any] = {
                "itemId": item["id"],
                "seq": item["ordinal"] + 1,
                "status": item["status"],
                "error": item["error_summary"]
                if item["error_summary"] is not None
                else item["error"],
                "errorSummary": item["error_summary"]
                if item["error_summary"] is not None
                else item["error"],
                "errorDetail": item["error_detail"]
                if item["error_detail"] is not None
                else item["error"],
                "diagnostics": json.loads(item["diagnostics_json"] or "[]"),
                "submitted": json.loads(item["submitted_json"]),
                # effective 在首次受理时写入，查询只读该快照，不重新合并账号默认。
                "effective": json.loads(item["effective_json"]),
            }
            if item["source_item_id"] is not None:
                item_result["sourceItemId"] = item["source_item_id"]
            result["items"].append(item_result)
        return result

    def latest_run(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        return self.get_run(row["id"]) if row else None


class FailClosedUploader:
    """生产未配置真实执行 seam 时显式失败，禁止把空操作当作成功。"""

    def __call__(self, _effective: Mapping[str, Any]) -> None:
        raise RuntimeError(FAIL_CLOSED_ERROR)


def _run_uploader_in_child(
    uploader: Callable[[Mapping[str, Any]], None],
    effective: Mapping[str, Any],
    result_conn: Any,
) -> None:
    """子进程入口：建立独立进程组并把执行结果传回 worker。"""
    get_diagnostics: Callable[[], list[dict[str, Any]]] | None = None
    try:
        if os.name != "nt":
            os.setsid()
        from posthub.uploader_wrapper import (
            clear_declaration_diagnostics,
            get_declaration_diagnostics,
        )
        from posthub.uploader_wrapper import install as install_uploader_wrapper

        get_diagnostics = get_declaration_diagnostics
        # child 不依赖 Flask request，独立重建 wrapper 的运行时引用，保证官方
        # publish_strategy、定时与声明适配不会因 spawn 而回退到上游原实现。
        install_uploader_wrapper()
        clear_declaration_diagnostics()
        result_conn.send({"kind": "ready"})
        acknowledgement = result_conn.recv()
        if (
            not isinstance(acknowledgement, dict)
            or acknowledgement.get("kind") != "ack"
        ):
            raise RuntimeError("item 子进程收到非法 ack")
        uploader(effective)
    except BaseException as exc:  # noqa: BLE001 - 结果必须回传给父进程
        diagnostics = get_diagnostics() if get_diagnostics is not None else []
        result = {
            "kind": "result",
            "error": str(exc),
            "detail": traceback.format_exc(),
            "diagnostics": diagnostics,
        }
    else:
        result = {
            "kind": "result",
            "error": None,
            "detail": None,
            "diagnostics": get_diagnostics(),
        }
    try:
        result_conn.send(result)
    except (BrokenPipeError, EOFError, OSError):
        pass
    finally:
        result_conn.close()


def _descendant_pids(root_pid: int) -> list[int]:
    """读取当前进程表中的后代，补足 POSIX 下 setsid 后代脱离进程组的情况。"""
    if os.name == "nt":
        return []
    try:
        output = subprocess.check_output(
            ["ps", "-axo", "pid=,ppid="], text=True, stderr=subprocess.DEVNULL
        )
    except (OSError, subprocess.SubprocessError):
        return []
    children: dict[int, list[int]] = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        try:
            pid, parent_pid = (int(value) for value in fields)
        except ValueError:
            continue
        children.setdefault(parent_pid, []).append(pid)
    descendants: list[int] = []
    pending = list(children.get(root_pid, []))
    while pending:
        pid = pending.pop()
        descendants.append(pid)
        pending.extend(children.get(pid, []))
    return descendants


def _terminate_process_tree(process: multiprocessing.Process) -> None:
    """强制终止 item 子进程及其后代，并回收父进程句柄。"""
    pid = process.pid
    if pid is None:
        return
    descendants = _descendant_pids(pid)
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            process.terminate()
    else:
        # 先按父子关系杀已发现的后代，再杀进程组；这样即使某个后代自行
        # setsid 脱离进程组，也不会因只 killpg 而遗留。
        for descendant_pid in reversed(descendants):
            try:
                os.kill(descendant_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                logger.debug(
                    "终止 item 后代失败：pid=%s", descendant_pid, exc_info=True
                )
        try:
            process_group = os.getpgid(pid)
            if process_group != os.getpgrp():
                os.killpg(process_group, signal.SIGKILL)
            else:
                process.terminate()
        except ProcessLookupError:
            pass
        except OSError:
            process.terminate()
    process.join(timeout=1.0)
    if process.is_alive():
        process.kill()
        process.join(timeout=1.0)


class RunWorker:
    """独立于页面生命周期的本地后台 worker。"""

    def __init__(
        self,
        store: RunStore,
        uploader: Callable[[Mapping[str, Any]], None] | None = None,
        step_delay: float = 0.02,
        *,
        lease_seconds: float = DEFAULT_LEASE_SECONDS,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT,
        item_timeout_seconds: float | None = None,
        isolate_processes: bool | None = None,
    ) -> None:
        self.store = store
        self.uploader = uploader if uploader is not None else FailClosedUploader()
        self.step_delay = step_delay
        self.lease_seconds = lease_seconds
        self.stop_timeout = stop_timeout
        self.item_timeout_seconds = (
            configured_item_timeout_seconds()
            if item_timeout_seconds is None
            else item_timeout_seconds
        )
        if (
            not math.isfinite(self.item_timeout_seconds)
            or self.item_timeout_seconds <= 0
        ):
            raise ValueError("item_timeout_seconds 必须是正数")
        # 生产组合显式开启子进程边界；闭包 fake 保留旧线程 seam，避免
        # 既有测试依赖的 threading.Event 在进程边界后失去共享语义。
        has_closure = bool(getattr(self.uploader, "__closure__", None))
        self._isolate_processes = (
            isolate_processes
            if isolate_processes is not None
            else item_timeout_seconds is not None or not has_closure
        )
        self._owner_token = str(uuid.uuid4())
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_alive:
            return
        self._thread = None
        self.store.recover_incomplete()
        self._owner_token = str(uuid.uuid4())
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="posthub-run-worker",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is None or thread is threading.current_thread():
            return
        thread.join(timeout=self.stop_timeout)
        if thread.is_alive():
            return
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            claimed = self.store.claim_next_item(
                self._owner_token, lease_seconds=self.lease_seconds
            )
            if claimed is None:
                self._stop.wait(0.01)
                continue
            run_id, item_id, effective = claimed
            if self.step_delay > 0 and self._stop.wait(self.step_delay):
                self.store.release_item(run_id, item_id, owner_token=self._owner_token)
                return
            if self._stop.is_set():
                self.store.release_item(run_id, item_id, owner_token=self._owner_token)
                return
            try:
                error, detail = self._execute_with_lease_heartbeat(
                    run_id, item_id, effective
                )
            except Exception as exc:
                error = str(exc)
                detail = traceback.format_exc()
                logger.exception("执行 item 异常：run=%s item=%s", run_id, item_id)
            try:
                finished = self.store.finish_item(
                    run_id,
                    item_id,
                    owner_token=self._owner_token,
                    error=error,
                    error_detail=detail,
                )
            except Exception:
                logger.exception("完成 item 失败：run=%s item=%s", run_id, item_id)
            else:
                if not finished:
                    logger.warning(
                        "完成 item 失败：lease 已丢失或 item 状态已变化，run=%s item=%s",
                        run_id,
                        item_id,
                    )

    def _execute_isolated_item(
        self, effective: Mapping[str, Any]
    ) -> tuple[str | None, str | None, list[dict[str, Any]]]:
        """在独立子进程执行一个 item，超时后强杀整个进程组。"""
        # worker 本身运行在线程中，禁止 fork 继承可能持锁的解释器状态；
        # spawn 也要求 run_backend.py 有 main guard，避免子进程重复启动 daemon。
        context = multiprocessing.get_context("spawn")
        parent_conn, child_conn = context.Pipe()
        process = context.Process(
            target=_run_uploader_in_child,
            args=(self.uploader, dict(effective), child_conn),
            name="posthub-run-item",
        )
        try:
            process.start()
        except Exception as exc:  # noqa: BLE001 - 启动失败落当前 item 终态
            child_conn.close()
            parent_conn.close()
            return (
                f"item 子进程启动失败：{exc}",
                traceback.format_exc(),
                [],
            )
        child_conn.close()
        try:
            startup_deadline = time.monotonic() + max(5.0, self.item_timeout_seconds)
            deadline: float | None = None
            result: dict[str, Any] | None = None
            # 收到最终 result 后不再按 uploader 执行预算判定；finally 会负责
            # 等待/回收 child，避免“结果已到但 child 尚未退出”时误报超时。
            while process.is_alive() and result is None:
                try:
                    has_message = parent_conn.poll(0.01)
                except (EOFError, OSError) as exc:
                    abnormal = f"item 子进程 IPC 管道异常关闭：{str(exc) or 'EOF'}"
                    return abnormal, abnormal, []
                if has_message:
                    try:
                        message = parent_conn.recv()
                    except (EOFError, OSError) as exc:
                        abnormal = f"item 子进程 IPC 管道异常关闭：{str(exc) or 'EOF'}"
                        return abnormal, abnormal, []
                    if not isinstance(message, dict):
                        abnormal = "item 子进程返回结果格式非法：必须是 object"
                        return abnormal, abnormal, []
                    kind = message.get("kind")
                    if kind == "ready":
                        if deadline is not None:
                            abnormal = "item 子进程重复发送 ready"
                            return abnormal, abnormal, []
                        # spawn 启动成本不计入 uploader 的 item 超时预算。
                        try:
                            parent_conn.send({"kind": "ack"})
                        except (EOFError, OSError) as exc:
                            abnormal = (
                                f"item 子进程 IPC 写入失败：{str(exc) or '管道关闭'}"
                            )
                            return abnormal, abnormal, []
                        deadline = time.monotonic() + self.item_timeout_seconds
                    elif kind == "result":
                        result = message
                    else:
                        abnormal = f"item 子进程返回未知消息类型：{kind!r}"
                        return abnormal, abnormal, []
                now = time.monotonic()
                if deadline is None:
                    if now >= startup_deadline:
                        _terminate_process_tree(process)
                        message = "item 子进程启动超时：未进入执行状态，已终止子进程树"
                        return message, message, []
                elif now >= deadline:
                    _terminate_process_tree(process)
                    message = (
                        f"item 执行超时：超过 {self.item_timeout_seconds:g} 秒，"
                        "已终止子进程树"
                    )
                    return message, message, []
            if result is None:
                try:
                    has_message = parent_conn.poll()
                except (EOFError, OSError) as exc:
                    abnormal = f"item 子进程 IPC 管道异常关闭：{str(exc) or 'EOF'}"
                    return abnormal, abnormal, []
                if has_message:
                    try:
                        message = parent_conn.recv()
                    except (EOFError, OSError) as exc:
                        abnormal = f"item 子进程 IPC 管道异常关闭：{str(exc) or 'EOF'}"
                        return abnormal, abnormal, []
                    if isinstance(message, dict) and message.get("kind") == "result":
                        result = message
                    elif isinstance(message, dict) and message.get("kind") == "ready":
                        abnormal = f"item 子进程异常退出（退出码 {process.exitcode}）：缺少 result"
                        return abnormal, abnormal, []
                    else:
                        abnormal = "item 子进程返回结果格式非法：缺少 result"
                        return abnormal, abnormal, []
            if result is not None:
                required = {"error", "detail", "diagnostics"}
                missing = sorted(required - result.keys())
                if missing:
                    abnormal = f"item 子进程返回结果格式非法：缺少 {', '.join(missing)}"
                    return abnormal, abnormal, []
                error = result["error"]
                detail = result["detail"]
                diagnostics = result["diagnostics"]
                if (error is not None and not isinstance(error, str)) or (
                    detail is not None and not isinstance(detail, str)
                ):
                    abnormal = "item 子进程返回结果格式非法：error/detail 必须是 string 或 null"
                    return abnormal, abnormal, []
                if not isinstance(diagnostics, list) or any(
                    not isinstance(item, dict) for item in diagnostics
                ):
                    abnormal = (
                        "item 子进程返回结果格式非法：diagnostics 必须是 object 数组"
                    )
                    return abnormal, abnormal, []
                return error, detail, diagnostics
            message = f"item 子进程异常退出（退出码 {process.exitcode}）：未返回 result"
            return message, message, []
        finally:
            parent_conn.close()
            if process.is_alive():
                process.join(timeout=DEFAULT_STOP_TIMEOUT)
            if process.is_alive():
                _terminate_process_tree(process)
            else:
                process.join(timeout=0)

    def _execute_with_lease_heartbeat(
        self, run_id: str, item_id: str, effective: Mapping[str, Any]
    ) -> tuple[str | None, str | None]:
        """执行可能阻塞的 uploader，同时持续续租当前 item。"""
        finished = threading.Event()
        heartbeat: threading.Thread | None = None
        if self.lease_seconds > 0:
            # 先由 worker 线程同步续租，再启动 heartbeat，避免新线程尚未调度
            # 时短 lease 已过期并被另一个 worker 回收。
            heartbeat_lease_seconds = max(self.lease_seconds, 1.0)
            try:
                renewed = self.store.renew_lease(
                    run_id,
                    item_id,
                    owner_token=self._owner_token,
                    lease_seconds=heartbeat_lease_seconds,
                )
            except sqlite3.Error as exc:
                return LEASE_LOST_ERROR, f"{LEASE_LOST_ERROR}: {exc}"
            if not renewed:
                return LEASE_LOST_ERROR, LEASE_LOST_ERROR
            interval = max(0.005, min(heartbeat_lease_seconds / 10, 1.0))

            def renew() -> None:
                while not finished.is_set():
                    try:
                        renewed = self.store.renew_lease(
                            run_id,
                            item_id,
                            owner_token=self._owner_token,
                            lease_seconds=heartbeat_lease_seconds,
                        )
                    except sqlite3.Error:
                        # 短暂 SQLite 锁竞争不能让 heartbeat 静默退出；下一轮
                        # 继续续租，直到 uploader 完成或 lease owner 失效。
                        if finished.wait(interval):
                            return
                        continue
                    except Exception:
                        logger.exception(
                            "续租 item 异常：run=%s item=%s",
                            run_id,
                            item_id,
                        )
                        return
                    if not renewed:
                        logger.warning(
                            "续租 item 失败：lease 已丢失或 item 状态已变化，run=%s item=%s",
                            run_id,
                            item_id,
                        )
                        return
                    if finished.wait(interval):
                        return

            heartbeat = threading.Thread(
                target=renew, name="posthub-run-lease", daemon=True
            )
            heartbeat.start()
        error: str | None = None
        detail: str | None = None
        diagnostics: list[dict[str, Any]] = []
        diagnostics_error: str | None = None
        try:
            if self._isolate_processes:
                error, detail, diagnostics = self._execute_isolated_item(effective)
            else:
                from posthub.uploader_wrapper import (
                    clear_declaration_diagnostics,
                    get_declaration_diagnostics,
                )

                clear_declaration_diagnostics()
                try:
                    self.uploader(effective)
                except Exception as exc:  # noqa: BLE001 - item 必须落终态
                    error = str(exc)
                    detail = traceback.format_exc()
                diagnostics = get_declaration_diagnostics()
            try:
                if diagnostics:
                    try:
                        persisted = self.store.record_item_diagnostics(
                            run_id,
                            item_id,
                            owner_token=self._owner_token,
                            diagnostics=diagnostics,
                        )
                    except Exception as exc:  # noqa: BLE001 - 终态清理不能被 DB 打断
                        diagnostics_error = str(exc)
                    else:
                        if not persisted:
                            diagnostics_error = "record_item_diagnostics 返回 False"
                    if diagnostics_error:
                        logger.warning(
                            "诊断写入失败：run=%s item=%s account=%s reason=%s error=%s",
                            run_id,
                            item_id,
                            diagnostics[0].get("account", "unknown"),
                            diagnostics[0].get("reason", "unknown"),
                            diagnostics_error,
                        )
            except Exception as exc:
                diagnostics_error = str(exc)
                logger.exception(
                    "读取 item 诊断失败：run=%s item=%s error=%s",
                    run_id,
                    item_id,
                    diagnostics_error,
                )
            if diagnostics_error and error is None:
                error = f"诊断写入失败：{diagnostics_error}"
                detail = diagnostics_error
            return error, detail
        finally:
            # 即使隔离执行自身抛出异常，也必须停止 lease heartbeat。
            finished.set()
            if heartbeat is not None:
                heartbeat.join(timeout=1.0)


def _read_publish_accounts(db_path: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, type, filePath, userName, status, default_platform_fields FROM user_info"
        ).fetchall()
    return [
        {
            "id": row[0],
            "type": row[1],
            "filePath": row[2],
            "userName": row[3],
            "status": row[4],
            "default_platform_fields": row[5],
        }
        for row in rows
    ]


def register_run_routes(
    app: Flask,
    official_db_path: Path,
    run_db_path: Path,
    *,
    uploader: Callable[[Mapping[str, Any]], None] | None = None,
    item_timeout_seconds: float | None = None,
) -> RunWorker:
    """注册 accepted-run 路由并启动独立 worker；重复注册保持幂等。"""
    existing = app.extensions.get(_RUN_SERVICE_MARKER)
    if existing is not None:
        return existing["worker"]

    store = RunStore(run_db_path)
    worker = RunWorker(
        store,
        uploader=uploader,
        item_timeout_seconds=item_timeout_seconds,
        isolate_processes=True,
    )

    @app.post("/postRuns")
    @app.post("/posthub/runs")
    def accept_run():
        payload = request.get_json(silent=True)
        if isinstance(payload, dict):
            payloads = [payload]
        elif isinstance(payload, list) and payload:
            payloads = payload
        else:
            return jsonify(
                {"code": 400, "msg": "item 必须是 object 或非空数组", "data": None}
            ), 400
        if any(not isinstance(item, dict) for item in payloads):
            return jsonify(
                {"code": 400, "msg": "每个 item 必须是 object", "data": None}
            ), 400
        if any(item.get("enableTimer", False) for item in payloads):
            return jsonify(
                {"code": 400, "msg": "accepted run 只支持 immediate item", "data": None}
            ), 400
        try:
            normalized = normalize_publish_payloads(
                payloads, _read_publish_accounts(official_db_path)
            )
            run_id = store.create_run(normalized.effective)
        except ActiveRunConflict as err:
            return jsonify(
                {
                    "code": 409,
                    "msg": str(err),
                    "data": {"existingRunId": err.existing_run_id},
                }
            ), 409
        except (DuplicateSubmissionError, NormalizationError, ValueError) as err:
            return jsonify({"code": 400, "msg": str(err), "data": None}), 400
        except sqlite3.Error as err:
            logger.exception("受理 run 写入失败")
            return jsonify({"code": 500, "msg": str(err), "data": None}), 500
        return jsonify(
            {
                "code": 200,
                "msg": "已受理",
                "data": {
                    "runId": run_id,
                    "status": "pending",
                    "itemCount": len(normalized.effective),
                },
            }
        ), 200

    @app.get("/postRuns/latest")
    @app.get("/posthub/runs/latest")
    def get_latest_run():
        return jsonify({"code": 200, "msg": None, "data": store.latest_run()}), 200

    @app.get("/postRuns/<run_id>")
    @app.get("/posthub/runs/<run_id>")
    def get_run(run_id: str):
        result = store.get_run(run_id)
        if result is None:
            return jsonify({"code": 404, "msg": "run 不存在", "data": None}), 404
        return jsonify({"code": 200, "msg": None, "data": result}), 200

    @app.post("/postRuns/<run_id>/retry")
    @app.post("/posthub/runs/<run_id>/retry")
    def retry_run(run_id: str):
        raw_body = request.get_data(cache=True)
        payload = request.get_json(silent=True)
        if not raw_body:
            item_ids = None
        elif payload is None:
            return jsonify(
                {"code": 400, "msg": "retry 请求体不是合法 JSON object", "data": None}
            ), 400
        elif isinstance(payload, dict):
            item_ids = payload.get("itemIds")
            if item_ids is not None and (
                not isinstance(item_ids, list)
                or any(
                    not isinstance(item_id, str) or not item_id for item_id in item_ids
                )
            ):
                return jsonify(
                    {"code": 400, "msg": "itemIds 必须是字符串数组", "data": None}
                ), 400
        else:
            return jsonify(
                {"code": 400, "msg": "retry 请求体必须是 object", "data": None}
            ), 400
        try:
            new_run_id = store.retry_run(run_id, item_ids=item_ids)
            snapshot = store.get_run(new_run_id)
        except LookupError as err:
            return jsonify({"code": 404, "msg": str(err), "data": None}), 404
        except ActiveRunConflict as err:
            return jsonify(
                {
                    "code": 409,
                    "msg": str(err),
                    "data": {"existingRunId": err.existing_run_id},
                }
            ), 409
        except sqlite3.Error as err:
            logger.exception("retry run 写入失败")
            return jsonify({"code": 500, "msg": str(err), "data": None}), 500
        except ValueError as err:
            return jsonify({"code": 400, "msg": str(err), "data": None}), 400
        assert snapshot is not None
        return jsonify(
            {
                "code": 200,
                "msg": "已受理",
                "data": {
                    "runId": new_run_id,
                    "status": "pending",
                    "itemCount": len(snapshot["items"]),
                    "parentRunId": run_id,
                },
            }
        ), 200

    app.extensions[_RUN_ROUTE_MARKER] = True
    app.extensions[_RUN_SERVICE_MARKER] = {
        "db_path": Path(run_db_path).resolve(),
        "store": store,
        "worker": worker,
    }
    store.reconcile_daemon_startup()
    worker.start()
    return worker


def shutdown_run_worker(app: Flask) -> None:
    service = app.extensions.get(_RUN_SERVICE_MARKER)
    if service is not None:
        service["worker"].stop()
