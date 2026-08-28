"""单 immediate item accepted-run 的 HTTP / 持久化 / worker 契约。"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from flask import Flask

import sau_backend
from posthub.composition import compose_posthub_backend, shutdown_posthub_backend
from posthub.publish_adapter import (
    normalize_publish_payload,
    normalize_publish_payloads,
)
from posthub.runs import RunStore, RunWorker


@pytest.fixture
def run_app(tmp_path: Path):
    app = Flask(__name__)
    app.add_url_rule(
        "/postVideo",
        endpoint="postVideo",
        view_func=sau_backend.postVideo,
        methods=["POST"],
    )
    official_db = tmp_path / "official" / "db" / "database.db"
    compose_posthub_backend(app, official_db)
    with sqlite3.connect(official_db) as conn:
        conn.execute(
            """
            INSERT INTO user_info (type, filePath, userName, status)
            VALUES (3, 'douyin.json', '抖音测试号', 1)
            """
        )
        conn.commit()
    yield app, official_db
    shutdown_posthub_backend(app)


def immediate_payload() -> dict[str, object]:
    return {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "立即 item",
        "tags": ["测试"],
        "enableTimer": False,
    }


def wait_for_status(client, run_id: str, status: str, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    latest: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/postRuns/{run_id}")
        assert response.status_code == 200
        latest = response.get_json()["data"]
        if latest["status"] == status:
            return latest
        time.sleep(0.01)
    pytest.fail(f"run 未进入 {status}：{latest}")


def test_composition_rejects_reusing_official_db_for_run_history(
    tmp_path: Path,
) -> None:
    app = Flask(__name__)
    official_db = tmp_path / "official" / "db" / "database.db"
    with pytest.raises(ValueError, match="独立"):
        compose_posthub_backend(app, official_db, run_db_path=official_db)


def test_accept_immediate_item_returns_run_id_and_accepted_only(
    run_app: tuple[Flask, Path],
) -> None:
    app, official_db = run_app

    with app.test_client() as client:
        response = client.post("/postRuns", json=immediate_payload())

    assert response.status_code == 200
    body = response.get_json()
    assert body["code"] == 200
    assert body["msg"] == "已受理"
    assert isinstance(body["data"]["runId"], str)
    assert body["data"]["status"] == "pending"
    assert body["data"]["itemCount"] == 1

    run_db = official_db.parent / "posthub-runs.db"
    assert run_db.exists()
    with sqlite3.connect(official_db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert "runs" not in tables
    assert "run_items" not in tables


def test_accept_immediate_batch_creates_one_run_with_all_effective_items(
    run_app: tuple[Flask, Path],
) -> None:
    app, _official_db = run_app
    payload = [immediate_payload(), {**immediate_payload(), "title": "第二个 item"}]

    with app.test_client() as client:
        response = client.post("/postRuns", json=payload)
        assert response.status_code == 200
        accepted = response.get_json()["data"]
        assert accepted["itemCount"] == 2
        run_id = accepted["runId"]
        completed = wait_for_status(client, run_id, "completed")

    assert len(completed["items"]) == 2
    assert completed["summary"] == {
        "itemCount": 2,
        "pendingCount": 0,
        "runningCount": 0,
        "successCount": 0,
        "failedCount": 2,
        "completedCount": 2,
    }

    run_db = _official_db.parent / "posthub-runs.db"
    with sqlite3.connect(run_db) as conn:
        persisted = conn.execute(
            """
            SELECT ordinal, submitted_json, effective_json
            FROM run_items WHERE run_id = ? ORDER BY ordinal
            """,
            (run_id,),
        ).fetchall()
    assert [row[0] for row in persisted] == [0, 1]
    assert [json.loads(row[1])["title"] for row in persisted] == [
        "立即 item",
        "第二个 item",
    ]
    assert [json.loads(row[2])["accountList"] for row in persisted] == [
        ["douyin.json"],
        ["douyin.json"],
    ]


def test_query_observes_item_lifecycle_and_fail_closed_completed_run(
    run_app: tuple[Flask, Path],
) -> None:
    app, _official_db = run_app

    with app.test_client() as client:
        accepted = client.post("/postRuns", json=immediate_payload())
        run_id = accepted.get_json()["data"]["runId"]

        pending_or_running = client.get(f"/postRuns/{run_id}").get_json()["data"]
        assert pending_or_running["status"] in {"pending", "running", "completed"}
        assert pending_or_running["items"][0]["status"] in {
            "pending",
            "running",
            "failed",
        }

        completed = wait_for_status(client, run_id, "completed")

    assert completed["status"] == "completed"
    assert completed["items"] == [
        {
            "itemId": completed["items"][0]["itemId"],
            "status": "failed",
            "error": "未配置 immediate 发布执行器；生产组合必须注入真实官方执行 seam",
            "diagnostics": [],
            "submitted": immediate_payload(),
            "effective": {
                "fileList": ["video.mp4"],
                "accountList": ["douyin.json"],
                "type": 3,
                "title": "立即 item",
                "tags": ["测试"],
                "enableTimer": False,
            },
        }
    ]


def test_invalid_immediate_item_is_rejected_before_run_persistence(
    run_app: tuple[Flask, Path],
) -> None:
    app, official_db = run_app

    invalid = immediate_payload()
    invalid["title"] = ""
    with app.test_client() as client:
        response = client.post("/postRuns", json=invalid)

    assert response.status_code == 400
    assert response.get_json()["code"] == 400
    run_db = official_db.parent / "posthub-runs.db"
    with sqlite3.connect(run_db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM run_items").fetchone()[0] == 0


def test_store_exposes_pending_running_success_and_completed_transitions(
    tmp_path: Path,
) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    assert store.get_run(run_id)["status"] == "pending"
    assert store.get_run(run_id)["items"][0]["status"] == "pending"

    claimed = store.claim_next_item("owner-a")
    assert claimed is not None
    claimed_run_id, item_id, _effective = claimed
    assert claimed_run_id == run_id
    assert store.get_run(run_id)["status"] == "running"
    assert store.get_run(run_id)["items"][0]["status"] == "running"

    store.finish_item(run_id, item_id, owner_token="owner-a")
    assert store.get_run(run_id)["status"] == "completed"
    assert store.get_run(run_id)["items"][0]["status"] == "success"


def test_worker_executes_persisted_effective_item_and_marks_success(
    tmp_path: Path,
) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    seen: list[dict] = []
    worker = RunWorker(store, uploader=lambda effective: seen.append(dict(effective)))
    worker.start()
    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            snapshot = store.get_run(run_id)
            if snapshot and snapshot["status"] == "completed":
                break
            time.sleep(0.01)
    finally:
        worker.stop()

    assert seen == [normalized.effective[0].effective]
    assert store.get_run(run_id)["items"][0]["status"] == "success"


def test_default_worker_fails_closed_instead_of_marking_success(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    worker = RunWorker(store)
    worker.start()
    try:
        completed = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert completed["items"][0]["status"] == "failed"
    assert "未配置 immediate 发布执行器" in completed["items"][0]["error"]


def test_worker_restart_recovers_expired_running_item(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    first = RunWorker(store, step_delay=1, lease_seconds=0)
    first.start()
    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if store.get_run(run_id)["status"] == "running":
                break
            time.sleep(0.01)
    finally:
        first.stop()

    second = RunWorker(store, lease_seconds=0, uploader=lambda _effective: None)
    second.start()
    try:
        wait_for_status_from_store(store, run_id, "completed")
    finally:
        second.stop()

    assert store.get_run(run_id)["items"][0]["status"] == "success"


def test_empty_error_is_still_failed_not_success(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    claimed = store.claim_next_item("owner-a")
    assert claimed is not None
    _, item_id, _ = claimed

    assert store.finish_item(run_id, item_id, owner_token="owner-a", error="")
    item = store.get_run(run_id)["items"][0]
    assert item["status"] == "failed"
    assert item["error"] == ""


def test_stop_after_claim_requeues_before_uploader_and_allows_restart(
    tmp_path: Path,
) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    calls: list[dict] = []
    first = RunWorker(
        store,
        uploader=lambda effective: calls.append(effective),
        step_delay=1,
    )
    first.start()
    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if store.get_run(run_id)["status"] == "running":
                break
            time.sleep(0.01)
        assert store.get_run(run_id)["status"] == "running"
        first.stop()
    finally:
        first.stop()

    snapshot = store.get_run(run_id)
    assert snapshot["status"] == "pending"
    assert snapshot["items"][0]["status"] == "pending"
    assert calls == []

    second = RunWorker(store, uploader=lambda effective: calls.append(effective))
    second.start()
    try:
        wait_for_status_from_store(store, run_id, "completed")
    finally:
        second.stop()

    assert calls == [normalized.effective[0].effective]


def test_blocked_uploader_renews_lease_before_another_worker_can_claim(
    tmp_path: Path,
) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    entered = threading.Event()
    release = threading.Event()
    first_calls: list[dict] = []
    second_calls: list[dict] = []

    def blocked_uploader(effective: dict) -> None:
        entered.set()
        release.wait(1)
        first_calls.append(effective)

    first = RunWorker(
        store,
        uploader=blocked_uploader,
        lease_seconds=0.12,
        stop_timeout=0.01,
    )
    second = RunWorker(
        store,
        uploader=lambda effective: second_calls.append(effective),
        lease_seconds=0.12,
    )
    first.start()
    try:
        assert entered.wait(1)
        time.sleep(0.35)
        second.start()
        time.sleep(0.05)
        assert second_calls == []
        release.set()
        wait_for_status_from_store(store, run_id, "completed")
        assert first_calls == [normalized.effective[0].effective]
        assert second_calls == []
    finally:
        release.set()
        first.stop()
        second.stop()


def test_workers_do_not_recover_active_owner_and_finish_checks_owner(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "posthub-runs.db"
    first_store = RunStore(db_path)
    second_store = RunStore(db_path)
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = first_store.create_run(normalized.effective)
    claimed = first_store.claim_next_item("owner-a", lease_seconds=60)
    assert claimed is not None
    _, item_id, _ = claimed

    second_store.recover_incomplete()
    assert second_store.claim_next_item("owner-b", lease_seconds=60) is None
    second_store.finish_item(run_id, item_id, owner_token="owner-b")
    assert first_store.get_run(run_id)["items"][0]["status"] == "running"

    first_store.finish_item(run_id, item_id, owner_token="owner-a")
    assert first_store.get_run(run_id)["items"][0]["status"] == "success"


def test_stop_keeps_blocked_worker_reference_and_prevents_duplicate_recovery(
    tmp_path: Path,
) -> None:
    store = RunStore(tmp_path / "posthub-runs.db")
    normalized = normalize_publish_payload(
        immediate_payload(),
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    entered = threading.Event()
    release = threading.Event()
    calls: list[dict] = []

    def blocked_uploader(effective: dict) -> None:
        entered.set()
        release.wait(2)
        calls.append(effective)

    first = RunWorker(
        store,
        uploader=blocked_uploader,
        lease_seconds=60,
        stop_timeout=0.02,
    )
    first.start()
    replacement_calls: list[dict] = []
    second = RunWorker(
        store,
        uploader=lambda effective: replacement_calls.append(effective),
        lease_seconds=60,
        stop_timeout=0.02,
    )
    try:
        assert entered.wait(1)
        first.stop()
        assert first.is_alive

        second.start()
        time.sleep(0.05)
        assert replacement_calls == []

        release.set()
        wait_for_status_from_store(store, run_id, "completed")
        assert calls == [normalized.effective[0].effective]
        assert replacement_calls == []
    finally:
        release.set()
        first.stop()
        second.stop()


def wait_for_status_from_store(store: RunStore, run_id: str, status: str) -> dict:
    deadline = time.monotonic() + 2
    latest: dict | None = None
    while time.monotonic() < deadline:
        latest = store.get_run(run_id)
        if latest and latest["status"] == status:
            return latest
        time.sleep(0.01)
    pytest.fail(f"run 未进入 {status}：{latest}")


def test_run_detail_exposes_first_acceptance_effective_douyin_snapshot(
    run_app: tuple[Flask, Path],
) -> None:
    app, official_db = run_app
    with sqlite3.connect(official_db) as conn:
        conn.execute(
            "UPDATE user_info SET default_platform_fields = ? WHERE filePath = ?",
            ('{"douyin":{"declaration":"no_need"}}', "douyin.json"),
        )
        conn.commit()

    with app.test_client() as client:
        accepted = client.post("/postRuns", json=immediate_payload())
        run_id = accepted.get_json()["data"]["runId"]
        detail = client.get(f"/postRuns/{run_id}").get_json()["data"]

    effective = detail["items"][0]["effective"]
    assert effective["platformFields"] == {"douyin": {"declaration": "no_need"}}

    # 受理后改变账号默认，不得改写已经持久化的 item effective 快照。
    with sqlite3.connect(official_db) as conn:
        conn.execute(
            "UPDATE user_info SET default_platform_fields = ? WHERE filePath = ?",
            ('{"douyin":{"declaration":"ai_generated"}}', "douyin.json"),
        )
        conn.commit()
    with app.test_client() as client:
        after_change = client.get(f"/postRuns/{run_id}").get_json()["data"]
    assert after_change["items"][0]["effective"] == effective


def test_latest_run_query_returns_completed_run_after_worker_finishes(
    run_app: tuple[Flask, Path],
) -> None:
    app, _official_db = run_app

    with app.test_client() as client:
        accepted = client.post("/postRuns", json=immediate_payload())
        run_id = accepted.get_json()["data"]["runId"]
        wait_for_status(client, run_id, "completed")
        latest = client.get("/postRuns/latest")

    assert latest.status_code == 200
    assert latest.get_json()["data"]["runId"] == run_id
    assert latest.get_json()["data"]["status"] == "completed"


def test_mixed_immediate_timer_run_detail_matches_fake_uploader_effective_payload(
    tmp_path: Path,
) -> None:
    immediate = immediate_payload()
    timer = {
        **immediate,
        "title": "分钟定时",
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["14:37"],
        "startDays": 1,
    }
    account = {
        "id": 1,
        "type": 3,
        "filePath": "douyin.json",
        "userName": "抖音测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payloads(
        [immediate, timer],
        [account],
        now=datetime(2026, 8, 27, 23, 50, tzinfo=UTC).replace(tzinfo=None),
    )
    store = RunStore(tmp_path / "runs.db")
    run_id = store.create_run(normalized.effective)
    seen: list[dict] = []
    worker = RunWorker(store, uploader=lambda effective: seen.append(dict(effective)))
    worker.start()
    try:
        detail = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert seen == [item.effective for item in normalized.effective]
    assert detail["items"][0]["effective"].get("publishDatetimes") is None
    assert detail["items"][1]["effective"]["publishDatetimes"] == [
        "2026-08-29T14:37:00"
    ]
    assert detail["items"][1]["submitted"]["dailyTimes"] == ["14:37"]


def test_wechat_timer_run_detail_keeps_submitted_and_effective_resolution(
    tmp_path: Path,
) -> None:
    payload = {
        "fileList": ["wechat.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "视频号 run 详情",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["23:30"],
        "startDays": 0,
    }
    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payloads(
        [payload],
        [account],
        now=datetime(2026, 8, 27, 12, 0, tzinfo=UTC).replace(tzinfo=None),
    )
    store = RunStore(tmp_path / "runs.db")
    run_id = store.create_run(normalized.effective)

    item = store.get_run(run_id)["items"][0]
    assert item["submitted"]["dailyTimes"] == ["23:30"]
    assert item["effective"]["dailyTimes"] == ["00:00"]
    assert item["effective"]["timerOriginalTime"] == "23:30"
    assert item["effective"]["timerFinalTime"] == "00:00"
    assert item["effective"]["timerResolutions"][0]["dayCarry"] == 1


def test_platform_rejection_only_fails_current_item_and_next_item_runs(
    tmp_path: Path,
) -> None:
    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    first = {
        "fileList": ["rejected.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "平台拒绝",
        "tags": [],
        "enableTimer": False,
    }
    second = {**first, "fileList": ["accepted.mp4"], "title": "后续 item"}
    normalized = normalize_publish_payloads([first, second], [account])
    store = RunStore(tmp_path / "runs.db")

    def uploader(effective: dict) -> None:
        if effective["title"] == "平台拒绝":
            raise RuntimeError("平台拒绝当前 item")

    run_id = store.create_run(normalized.effective)
    worker = RunWorker(store, uploader=uploader)
    worker.start()
    try:
        detail = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert [item["status"] for item in detail["items"]] == ["failed", "success"]
    assert detail["items"][0]["error"] == "平台拒绝当前 item"
    assert detail["items"][1]["error"] is None


def test_item_detail_persists_dom_warning_and_debug_screenshot(
    tmp_path: Path,
) -> None:
    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号声明",
            "tags": [],
            "enableTimer": False,
        },
        [account],
    )
    store = RunStore(tmp_path / "runs.db")
    run_id = store.create_run(normalized.effective)
    claimed = store.claim_next_item("dom-worker")
    assert claimed is not None
    _, item_id, _ = claimed

    diagnostics = [
        {
            "level": "warning",
            "kind": "wechat_content_declaration",
            "account": "wechat.json",
            "reason": "option_unavailable",
            "selector": 'text="添加声明"',
            "screenshot": "/tmp/wechat-declaration.png",
        }
    ]
    assert store.record_item_diagnostics(
        run_id,
        item_id,
        owner_token="dom-worker",
        diagnostics=diagnostics,
    )

    detail = store.get_run(run_id)
    assert detail["items"][0]["diagnostics"] == diagnostics


@pytest.mark.parametrize("reset_mode", ["release", "recover"])
def test_claim_and_recover_clear_previous_item_diagnostics(
    tmp_path: Path, reset_mode: str
) -> None:
    store = RunStore(tmp_path / "runs.db")
    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号声明",
            "tags": [],
            "enableTimer": False,
        },
        [account],
    )
    run_id = store.create_run(normalized.effective)
    claimed = store.claim_next_item(
        "diagnostic-worker", lease_seconds=0 if reset_mode == "recover" else 60
    )
    assert claimed is not None
    _, item_id, _ = claimed
    assert store.record_item_diagnostics(
        run_id,
        item_id,
        owner_token="diagnostic-worker",
        diagnostics=[{"level": "warning", "reason": "old-item"}],
    )

    if reset_mode == "release":
        assert store.release_item(run_id, item_id, owner_token="diagnostic-worker")
    else:
        store.recover_incomplete()

    next_claim = store.claim_next_item("retry-worker")
    assert next_claim is not None
    assert store.get_run(run_id)["items"][0]["diagnostics"] == []


def test_worker_marks_item_failed_when_diagnostic_persistence_returns_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from posthub import uploader_wrapper

    store = RunStore(tmp_path / "runs.db")
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号声明",
            "tags": [],
            "enableTimer": False,
        },
        [
            {
                "id": 1,
                "type": 2,
                "filePath": "wechat.json",
                "userName": "视频号测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)

    def uploader(_effective: dict) -> None:
        uploader_wrapper._record_declaration_diagnostic(
            level="warning", kind="wechat_content_declaration", reason="db-test"
        )

    monkeypatch.setattr(store, "record_item_diagnostics", lambda *args, **kwargs: False)
    worker = RunWorker(store, uploader=uploader)
    worker.start()
    try:
        detail = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert detail["items"][0]["status"] == "failed"
    assert "诊断写入失败" in detail["items"][0]["error"]


def test_worker_marks_item_failed_when_diagnostic_persistence_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from posthub import uploader_wrapper

    store = RunStore(tmp_path / "runs.db")
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号声明",
            "tags": [],
            "enableTimer": False,
        },
        [
            {
                "id": 1,
                "type": 2,
                "filePath": "wechat.json",
                "userName": "视频号测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)

    def uploader(_effective: dict) -> None:
        uploader_wrapper._record_declaration_diagnostic(
            level="warning", kind="wechat_content_declaration", reason="db-test"
        )

    def fail_record(*args: object, **kwargs: object) -> bool:
        raise sqlite3.OperationalError("diagnostics db down")

    monkeypatch.setattr(store, "record_item_diagnostics", fail_record)
    worker = RunWorker(store, uploader=uploader)
    worker.start()
    try:
        detail = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert detail["items"][0]["status"] == "failed"
    assert "诊断写入失败" in detail["items"][0]["error"]


def test_worker_logs_finish_lease_loss_without_interrupting_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    store = RunStore(tmp_path / "runs.db")
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["douyin.json"],
            "type": 3,
            "title": "抖音",
            "tags": [],
            "enableTimer": False,
        },
        [
            {
                "id": 1,
                "type": 3,
                "filePath": "douyin.json",
                "userName": "抖音测试号",
                "status": 1,
                "default_platform_fields": None,
            }
        ],
    )
    run_id = store.create_run(normalized.effective)
    entered = threading.Event()

    def uploader(_effective: dict) -> None:
        entered.set()

    monkeypatch.setattr(store, "finish_item", lambda *args, **kwargs: False)
    worker = RunWorker(store, uploader=uploader)
    worker.start()
    try:
        assert entered.wait(1)
        time.sleep(0.05)
        assert worker.is_alive
    finally:
        worker.stop()

    assert "完成 item 失败" in caplog.text
    assert store.get_run(run_id)["items"][0]["status"] == "running"


def test_worker_persists_wrapper_diagnostics_before_item_finishes(
    tmp_path: Path,
) -> None:
    from posthub import uploader_wrapper

    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号测试号",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payload(
        {
            "fileList": ["video.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号声明",
            "tags": [],
            "enableTimer": False,
        },
        [account],
    )
    store = RunStore(tmp_path / "runs.db")
    run_id = store.create_run(normalized.effective)

    def uploader(_effective: dict) -> None:
        uploader_wrapper._record_declaration_diagnostic(
            level="warning",
            kind="wechat_content_declaration",
            account="wechat.json",
            reason="entry_unavailable",
            screenshot="/tmp/debug.png",
        )

    worker = RunWorker(store, uploader=uploader)
    worker.start()
    try:
        detail = wait_for_status_from_store(store, run_id, "completed")
    finally:
        worker.stop()

    assert detail["items"][0]["diagnostics"][0]["reason"] == "entry_unavailable"
    assert detail["items"][0]["diagnostics"][0]["screenshot"] == "/tmp/debug.png"
