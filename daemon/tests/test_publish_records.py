"""scheduled 发布记录与账号周日历 HTTP 契约。"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from flask import Flask, g, jsonify
from posthub import uploader_wrapper
from posthub.composition import compose_posthub_backend, shutdown_posthub_backend


def timer_payload() -> dict[str, object]:
    return {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "定时标题",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["14:37"],
        "startDays": 1,
    }


def build_app(tmp_path: Path, *, response_status: int = 200) -> tuple[Flask, Path]:
    app = Flask(__name__)

    def post_video():
        return jsonify({"code": response_status, "data": None}), response_status

    app.add_url_rule(
        "/postVideo", endpoint="postVideo", view_func=post_video, methods=["POST"]
    )
    official_db = tmp_path / "official" / "db" / "database.db"
    compose_posthub_backend(app, official_db)
    with sqlite3.connect(official_db) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName, status) VALUES (3, ?, ?, 1)",
            ("douyin.json", "原始账号名"),
        )
        conn.commit()
    return app, official_db


def test_batch_records_successful_items_before_later_item_failure(
    tmp_path: Path,
) -> None:
    app = Flask(__name__)

    def post_video_batch():
        for item in g.posthub_normalized_batch.effective:
            if item.effective["title"] == "失败项":
                raise RuntimeError("平台拒绝")
            uploader_wrapper._execute_effective_group([item], lambda _command: None)
        return jsonify({"code": 200, "data": None}), 200

    app.add_url_rule(
        "/postVideoBatch",
        endpoint="postVideoBatch",
        view_func=post_video_batch,
        methods=["POST"],
    )
    official_db = tmp_path / "official" / "db" / "database.db"
    compose_posthub_backend(app, official_db)
    with sqlite3.connect(official_db) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName, status) VALUES (3, ?, ?, 1)",
            ("douyin.json", "账号"),
        )
        conn.commit()

    first = timer_payload()
    second = {**timer_payload(), "fileList": ["bad.mp4"], "title": "失败项"}
    try:
        with app.test_client() as client:
            response = client.post("/postVideoBatch", json=[first, second])
            assert response.status_code == 500
            records = client.get("/publishRecords?from=2026-01-01&to=2027-01-01")

        assert records.status_code == 200
        data = records.get_json()["data"]
        assert [row["videoId"] for row in data] == ["video.mp4"]
        assert data[0]["videoTitle"] == "定时标题"
    finally:
        shutdown_posthub_backend(app)


def test_scheduled_success_records_effective_time_and_account_snapshot(
    monkeypatch, tmp_path: Path
) -> None:
    from posthub import publish_adapter

    monkeypatch.setattr(
        publish_adapter,
        "_local_naive_now",
        lambda: datetime(2026, 8, 29, 23, 50, tzinfo=UTC).replace(tzinfo=None),
    )
    app, _official_db = build_app(tmp_path)
    try:
        with app.test_client() as client:
            response = client.post("/postVideo", json=timer_payload())
            assert response.status_code == 200
            records = client.get("/publishRecords?from=2026-08-31&to=2026-08-31")

        assert records.status_code == 200
        body = records.get_json()
        assert body["code"] == 200
        assert body["data"] == [
            {
                "id": body["data"][0]["id"],
                "accountId": 1,
                "accountFile": "douyin.json",
                "accountName": "原始账号名",
                "platform": "douyin",
                "videoId": "video.mp4",
                "videoTitle": "定时标题",
                "effectiveScheduledFor": "2026-08-31 14:37:00",
                "scheduledFor": "2026-08-31 14:37:00",
                "status": "scheduled",
                "publishedAt": None,
                "runId": None,
                "runItemId": None,
                "recordedAt": body["data"][0]["recordedAt"],
            }
        ]
    finally:
        shutdown_posthub_backend(app)


def test_scheduled_failure_writes_no_record(tmp_path: Path) -> None:
    app, _official_db = build_app(tmp_path, response_status=500)
    try:
        with app.test_client() as client:
            response = client.post("/postVideo", json=timer_payload())
            assert response.status_code == 500
            records = client.get("/publishRecords?from=2026-08-29&to=2026-09-10")

        assert records.status_code == 200
        assert records.get_json()["data"] == []
    finally:
        shutdown_posthub_backend(app)


def test_publish_record_survives_account_rename_and_delete(tmp_path: Path) -> None:
    app, official_db = build_app(tmp_path)
    try:
        with app.test_client() as client:
            assert client.post("/postVideo", json=timer_payload()).status_code == 200
            with sqlite3.connect(official_db) as conn:
                conn.execute("UPDATE user_info SET userName = '新账号名' WHERE id = 1")
                conn.execute("DELETE FROM user_info WHERE id = 1")
                conn.commit()
            records = client.get("/publishRecords?from=2026-01-01&to=2027-01-01")

        assert records.status_code == 200
        assert records.get_json()["data"][0]["accountName"] == "原始账号名"
        assert records.get_json()["data"][0]["accountId"] == 1
    finally:
        shutdown_posthub_backend(app)


def immediate_payload() -> dict[str, object]:
    return {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "立即标题",
        "tags": [],
        "enableTimer": False,
    }


def test_immediate_success_record_has_published_at_and_nullable_schedule(
    monkeypatch, tmp_path: Path
) -> None:
    from posthub import publish_adapter

    published_at = datetime(2026, 8, 29, 15, 4, 5, tzinfo=UTC).replace(tzinfo=None)
    monkeypatch.setattr(publish_adapter, "_local_naive_now", lambda: published_at)
    app, _official_db = build_app(tmp_path)
    try:
        with app.test_client() as client:
            response = client.post("/postVideo", json=immediate_payload())
            assert response.status_code == 200
            records = client.get("/publishRecords?from=2026-08-29&to=2026-08-29")

        assert records.status_code == 200
        data = records.get_json()["data"]
        assert len(data) == 1
        assert data[0]["status"] == "published"
        assert data[0]["scheduledFor"] is None
        assert data[0]["effectiveScheduledFor"] is None
        assert data[0]["publishedAt"] == "2026-08-29 15:04:05"
    finally:
        shutdown_posthub_backend(app)


def test_publish_records_date_range_and_order_use_published_at_fallback(
    tmp_path: Path,
) -> None:
    from posthub.publish_records import PublishRecordStore

    store = PublishRecordStore(tmp_path / "posthub-runs.db")
    store.record_successful_payload(
        immediate_payload(),
        account_id=1,
        account_file="douyin.json",
        account_name="账号",
        platform="douyin",
        published_at=datetime(2026, 8, 29, 10, 0, tzinfo=UTC).replace(tzinfo=None),
    )
    result = store.list_records(start_date="2026-08-29", end_date="2026-08-29")
    assert len(result) == 1
    assert result[0]["publishedAt"] == "2026-08-29 10:00:00"


def test_publish_fingerprint_only_changes_with_video_or_account(tmp_path: Path) -> None:
    from posthub.publish_records import PublishRecordStore, publish_fingerprint

    store = PublishRecordStore(tmp_path / "posthub-runs.db")
    first = store.record_successful_payload(
        immediate_payload(),
        account_id=1,
        account_file="douyin.json",
        account_name="账号",
        platform="douyin",
        published_at=datetime(2026, 8, 29, 10, 0, tzinfo=UTC).replace(tzinfo=None),
    )[0]
    second_payload = {**immediate_payload(), "title": "另一个标题", "tags": ["不同"]}
    assert publish_fingerprint("douyin", 1, "douyin.json", "video.mp4")
    assert (
        store.find_successful_duplicates(
            [
                {
                    "platform": "douyin",
                    "accountId": 1,
                    "accountFile": "douyin.json",
                    "fileList": ["video.mp4"],
                },
                {
                    "platform": "douyin",
                    "accountId": 2,
                    "accountFile": "other.json",
                    "fileList": ["video.mp4"],
                },
                {
                    "platform": "douyin",
                    "accountId": 1,
                    "accountFile": "douyin.json",
                    "fileList": ["other.mp4"],
                },
            ]
        )[0]["videoTitle"]
        == "立即标题"
    )
    assert second_payload["title"] != first["videoTitle"]


def test_cross_submission_duplicate_check_warns_without_run_and_confirm_allows_run(
    tmp_path: Path,
) -> None:
    app, official_db = build_app(tmp_path)
    try:
        with app.test_client() as client:
            assert (
                client.post("/postVideo", json=immediate_payload()).status_code == 200
            )
            check = client.post("/publishRecords/check", json=immediate_payload())
            assert check.status_code == 200
            duplicates = check.get_json()["data"]["duplicates"]
            assert len(duplicates) == 1
            assert duplicates[0]["videoId"] == "video.mp4"

            blocked = client.post("/postRuns", json=immediate_payload())
            assert blocked.status_code == 409
            assert blocked.get_json()["data"]["kind"] == "history_duplicate"
            with sqlite3.connect(official_db.parent / "posthub-runs.db") as conn:
                assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0

            confirmed = client.post(
                "/postRuns",
                json=immediate_payload(),
                headers={"X-PostHub-Confirm-Duplicates": "true"},
            )
            assert confirmed.status_code == 200
    finally:
        shutdown_posthub_backend(app)
