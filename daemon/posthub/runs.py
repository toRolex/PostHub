"""PostHub-owned 单 immediate item accepted-run 观察主干。

该模块只保存本机 run/item 记录并驱动可替换的 fake uploader；不替代官方
发布执行，也不实现通用 scheduler、重试、限速或并发策略。
"""

from __future__ import annotations

import json
import sqlite3
import threading
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
FAIL_CLOSED_ERROR = "未配置 immediate 发布执行器；生产组合必须注入真实官方执行 seam"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _lease_until(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=max(0.0, seconds))).isoformat(
        timespec="milliseconds"
    )


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
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS run_items (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    ordinal INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
                    submitted_json TEXT NOT NULL,
                    effective_json TEXT NOT NULL,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_run_items_status ON run_items(status);
                """
            )
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(run_items)").fetchall()
            }
            if "lease_owner" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN lease_owner TEXT")
            if "lease_until" not in columns:
                conn.execute("ALTER TABLE run_items ADD COLUMN lease_until TEXT")

    def create_run(self, items: Iterable[EffectiveBatchItem]) -> str:
        effective_items = list(items)
        if not effective_items:
            raise ValueError("run 至少需要一个 item")
        run_id = str(uuid.uuid4())
        now = _now()
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO runs (id, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)",
                (run_id, now, now),
            )
            for ordinal, item in enumerate(effective_items):
                conn.execute(
                    """
                    INSERT INTO run_items
                      (id, run_id, ordinal, status, submitted_json, effective_json,
                       created_at, updated_at)
                    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        run_id,
                        ordinal,
                        json.dumps(item.submitted, ensure_ascii=False),
                        json.dumps(item.effective, ensure_ascii=False),
                        now,
                        now,
                    ),
                )
        return run_id

    def recover_incomplete(self) -> None:
        """只回收 lease 已过期的 running item，保留仍由其他 worker 持有的 item。"""
        now = _now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE run_items
                SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
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
                SET status = 'running', lease_owner = ?, lease_until = ?, updated_at = ?
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
                SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
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

    def finish_item(
        self,
        run_id: str,
        item_id: str,
        *,
        owner_token: str,
        error: str | None = None,
    ) -> bool:
        """仅允许持有当前 lease 的 worker 完成 item；返回是否完成。"""
        if not owner_token:
            raise ValueError("worker owner token 不能为空")
        now = _now()
        status = "failed" if error is not None else "success"
        with self._lock, self._connect() as conn:
            updated = conn.execute(
                """
                UPDATE run_items
                SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
                WHERE id = ? AND run_id = ? AND status = 'running' AND lease_owner = ?
                """,
                (status, error, now, item_id, run_id, owner_token),
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
                conn.execute(
                    """
                    UPDATE runs SET status = 'completed', updated_at = ?, completed_at = ?
                    WHERE id = ?
                    """,
                    (now, now, run_id),
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
                SELECT id, ordinal, status, error, submitted_json, effective_json
                FROM run_items WHERE run_id = ? ORDER BY ordinal
                """,
                (run_id,),
            ).fetchall()
        counts = Counter(item["status"] for item in items)
        item_count = len(items)
        return {
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
                "completedCount": counts["success"] + counts["failed"],
            },
            "items": [
                {
                    "itemId": item["id"],
                    "status": item["status"],
                    "error": item["error"],
                    "submitted": json.loads(item["submitted_json"]),
                    # effective 在首次受理时写入，查询只读该快照，不重新合并账号默认。
                    "effective": json.loads(item["effective_json"]),
                }
                for item in items
            ],
        }

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
    ) -> None:
        self.store = store
        self.uploader = uploader if uploader is not None else FailClosedUploader()
        self.step_delay = step_delay
        self.lease_seconds = lease_seconds
        self.stop_timeout = stop_timeout
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
            error = self._execute_with_lease_heartbeat(run_id, item_id, effective)
            self.store.finish_item(
                run_id, item_id, owner_token=self._owner_token, error=error
            )

    def _execute_with_lease_heartbeat(
        self, run_id: str, item_id: str, effective: Mapping[str, Any]
    ) -> str | None:
        """执行可能阻塞的 uploader，同时持续续租当前 item。"""
        finished = threading.Event()
        heartbeat: threading.Thread | None = None
        if self.lease_seconds > 0:
            interval = max(0.01, min(self.lease_seconds / 3, 1.0))

            def renew() -> None:
                while not finished.wait(interval):
                    if not self.store.renew_lease(
                        run_id,
                        item_id,
                        owner_token=self._owner_token,
                        lease_seconds=self.lease_seconds,
                    ):
                        return

            heartbeat = threading.Thread(
                target=renew, name="posthub-run-lease", daemon=True
            )
            heartbeat.start()
        error: str | None = None
        try:
            self.uploader(effective)
        except Exception as exc:  # noqa: BLE001 - item 必须落终态
            error = str(exc)
        finally:
            finished.set()
            if heartbeat is not None:
                heartbeat.join(timeout=1.0)
        return error


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
) -> RunWorker:
    """注册 accepted-run 路由并启动独立 worker；重复注册保持幂等。"""
    existing = app.extensions.get(_RUN_SERVICE_MARKER)
    if existing is not None:
        return existing["worker"]

    store = RunStore(run_db_path)
    worker = RunWorker(store, uploader=uploader)

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
        except (NormalizationError, sqlite3.Error) as err:
            return jsonify({"code": 400, "msg": str(err), "data": None}), 400
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

    app.extensions[_RUN_ROUTE_MARKER] = True
    app.extensions[_RUN_SERVICE_MARKER] = {
        "db_path": Path(run_db_path).resolve(),
        "store": store,
        "worker": worker,
    }
    worker.start()
    return worker


def shutdown_run_worker(app: Flask) -> None:
    service = app.extensions.get(_RUN_SERVICE_MARKER)
    if service is not None:
        service["worker"].stop()
