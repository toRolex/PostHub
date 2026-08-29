"""Issue #100 最终删除性 gate。"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest
from flask import Flask

from posthub.composition import compose_posthub_backend, shutdown_posthub_backend
from posthub.publish_adapter import NormalizationError, normalize_publish_payload
from posthub.uploader_wrapper import _fields_for

ROOT = Path(__file__).resolve().parents[2]
OFFICIAL_SAU_BACKEND_SHA256 = (
    "6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d"
)


def _account() -> dict[str, object]:
    return {
        "id": 1,
        "type": 3,
        "filePath": "douyin.json",
        "userName": "抖音测试号",
        "status": 1,
        "default_platform_fields": None,
    }


def _payload(**extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "标题",
        "tags": [],
        "enableTimer": False,
    }
    payload.update(extra)
    return payload


def test_composed_batch_endpoint_is_deprecated_and_never_executes_sync_loop(
    tmp_path: Path,
) -> None:
    app = Flask(__name__)
    app.add_url_rule(
        "/postVideoBatch",
        endpoint="postVideoBatch",
        view_func=lambda: pytest.fail("已废弃的 batch 路径不可执行"),
        methods=["POST"],
    )
    official_db = tmp_path / "official" / "db" / "database.db"
    calls: list[dict[str, object]] = []
    compose_posthub_backend(
        app,
        official_db,
        uploader=lambda item: calls.append(dict(item)),
    )
    try:
        with app.test_client() as client:
            response = client.post("/postVideoBatch", json=[_payload()])
        assert response.status_code == 410
        assert response.get_json() == {
            "code": 410,
            "msg": "批量发布已废弃，请使用 /postRuns 受理",
            "data": None,
        }
        assert calls == []
    finally:
        shutdown_posthub_backend(app)


def test_post_runs_accepts_scheduled_item_as_the_only_batch_seam(
    tmp_path: Path,
) -> None:
    app = Flask(__name__)
    official_db = tmp_path / "official" / "db" / "database.db"
    run_db = tmp_path / "posthub-runs.db"
    compose_posthub_backend(
        app, official_db, run_db_path=run_db, uploader=lambda _: None
    )
    try:
        with sqlite3.connect(official_db) as conn:
            conn.execute(
                "INSERT INTO user_info (type, filePath, userName, status) VALUES (3, ?, ?, 1)",
                ("douyin.json", "抖音测试号"),
            )
            conn.commit()
        with app.test_client() as client:
            response = client.post(
                "/postRuns",
                json=[
                    _payload(
                        enableTimer=True,
                        videosPerDay=1,
                        dailyTimes=["14:37"],
                        startDays=1,
                    )
                ],
            )
        assert response.status_code == 200
        assert response.get_json()["data"]["itemCount"] == 1
    finally:
        shutdown_posthub_backend(app)


@pytest.mark.parametrize(
    "extra, message",
    [
        (
            {
                "enableTimer": True,
                "videosPerDay": 1,
                "dailyTimes": [10],
                "startDays": 0,
            },
            "HH:MM",
        ),
        (
            {"platform_fields": {"douyin": {"declaration": "marketing"}}},
            "platform_fields",
        ),
    ],
)
def test_removed_legacy_payload_shapes_are_rejected(
    extra: dict[str, object], message: str
) -> None:
    with pytest.raises(NormalizationError, match=message):
        normalize_publish_payload(_payload(**extra), [_account()])


@pytest.mark.parametrize(
    "legacy_context",
    [
        {"platform": 3, "douyin": {"declaration": "无需添加自主声明"}},
        {"platform": 3, "declaration": "无需添加自主声明"},
    ],
)
def test_removed_legacy_declaration_context_shapes_are_rejected(
    legacy_context: dict[str, object],
) -> None:
    with pytest.raises((TypeError, ValueError), match="canonical"):
        _fields_for(legacy_context, 3)


def test_official_copy_hash_is_pinned_and_prototype_is_not_in_source_bundle() -> None:
    official_path = ROOT / "daemon" / "sau_backend.py"
    actual = hashlib.sha256(official_path.read_bytes()).hexdigest()
    assert actual == OFFICIAL_SAU_BACKEND_SHA256

    source_root = ROOT.parent / "web" / "src"
    source_files = list(source_root.rglob("*.ts")) + list(source_root.rglob("*.tsx"))
    prototype_references = [
        path
        for path in source_files
        if "prototype" in path.read_text(encoding="utf-8").lower()
        and "docs/prototypes" in path.read_text(encoding="utf-8").lower()
    ]
    assert prototype_references == []
