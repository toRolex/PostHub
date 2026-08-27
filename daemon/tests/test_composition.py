"""PostHub-owned 组合入口契约测试。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import myUtils.postVideo as official_post_video
import pytest
from flask import Flask

import sau_backend
from posthub import uploader_wrapper
from posthub.composition import compose_official_backend, compose_posthub_backend


def _rule_count(app, path: str) -> int:
    return sum(1 for rule in app.url_map.iter_rules() if rule.rule == path)


def test_repeated_composition_rejects_a_different_db_path(tmp_path: Path) -> None:
    app = Flask(__name__)
    first_db = tmp_path / "first" / "db" / "database.db"
    second_db = tmp_path / "second" / "db" / "database.db"

    compose_posthub_backend(app, first_db)

    with pytest.raises(ValueError, match="不同数据库"):
        compose_posthub_backend(app, second_db)


def test_repeated_composition_preserves_seams_and_uses_explicit_db(
    monkeypatch, tmp_path: Path
) -> None:
    """重复组合幂等，官方接口和 wrapper seam 都使用显式数据库。"""
    unselected_base = tmp_path / "unselected"
    db_path = tmp_path / "selected" / "db" / "database.db"
    monkeypatch.setattr(sau_backend, "BASE_DIR", unselected_base)

    first = compose_official_backend(db_path=db_path)
    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO user_info (type, filePath, userName, status)
            VALUES (?, 'a.json', ?, 1)
            """,
            [(1, "小红书测试号"), (2, "视频号测试号"), (3, "抖音测试号")],
        )
        conn.commit()
    selected_base = db_path.parent.parent
    assert sau_backend.BASE_DIR == selected_base
    assert official_post_video.BASE_DIR == selected_base
    route_counts = {
        path: _rule_count(first, path)
        for path in (
            "/getAccountDefaults",
            "/updateAccountDefaults",
            "/getAccounts",
            "/getFiles",
            "/postVideo",
            "/postVideoBatch",
        )
    }

    second = compose_official_backend(db_path=db_path)
    repeated_route_counts = {path: _rule_count(second, path) for path in route_counts}

    assert second is first
    assert repeated_route_counts == route_counts
    assert route_counts["/getAccountDefaults"] == 1
    assert route_counts["/updateAccountDefaults"] == 1
    assert route_counts["/getAccounts"] == 1
    assert route_counts["/getFiles"] == 1
    assert route_counts["/postVideo"] == 1
    assert route_counts["/postVideoBatch"] == 1

    xhs_calls: list[tuple] = []
    tencent_calls: list[tuple] = []
    douyin_calls: list[tuple] = []
    pending_fields: list[dict] = []
    pending_tencent_fields: list[dict] = []

    def fake_xhs(*args, **kwargs):
        xhs_calls.append((args, kwargs))

    def fake_tencent(*args, **kwargs):
        tencent_calls.append((args, kwargs))
        pending_tencent_fields.append(uploader_wrapper._active_fields(2).copy())

    def fake_douyin(*args, **kwargs):
        douyin_calls.append((args, kwargs))
        pending_fields.append(uploader_wrapper._active_fields(3).copy())

    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_XHS", fake_xhs)
    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_TENCENT", fake_tencent)
    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_DOUYIN", fake_douyin)

    with first.test_client() as client:
        assert client.get("/getAccounts").status_code == 200
        assert client.get("/getFiles").status_code == 200
        assert client.get("/getAccountDefaults").status_code == 200
        assert client.post("/postVideo", json={}).status_code == 400
        malformed_single = client.post("/postVideo", json=["not-an-item"])
        assert malformed_single.status_code == 400
        assert "item" in malformed_single.get_json()["msg"]
        malformed_batch = client.post(
            "/postVideoBatch",
            json=[
                {
                    "fileList": ["a.mp4"],
                    "accountList": ["a.json"],
                    "type": 3,
                    "title": "valid",
                },
                {
                    "fileList": [],
                    "accountList": ["a.json"],
                    "type": 3,
                    "title": "invalid",
                },
            ],
        )
        assert malformed_batch.status_code == 400
        assert douyin_calls == []

        unsupported_xhs = client.post(
            "/postVideo",
            json={
                "fileList": ["a.mp4"],
                "accountList": ["a.json"],
                "type": 1,
                "title": "xhs-unsupported-declaration",
                "platformFields": {"xiaohongshu": {"source": "self_declare"}},
            },
        )
        assert unsupported_xhs.status_code == 400
        assert "source" in unsupported_xhs.get_json()["msg"]
        assert xhs_calls == []

        # 小红书走真实 wrapper 入口；若递归或签名错误，这里不会返回 200。
        xhs_response = client.post(
            "/postVideo",
            json={
                "fileList": ["a.mp4"],
                "accountList": ["a.json"],
                "type": 1,
                "title": "xhs",
            },
        )
        assert xhs_response.status_code == 200

        unsupported_tencent_origin = client.post(
            "/postVideo",
            json={
                "fileList": ["a.mp4"],
                "accountList": ["a.json"],
                "type": 2,
                "title": "tencent-unsupported-origin",
                "platformFields": {"wechat": {"origin": False}},
            },
        )
        assert unsupported_tencent_origin.status_code == 400
        assert "origin" in unsupported_tencent_origin.get_json()["msg"]
        assert tencent_calls == []

        # 视频号声明进入明确的 wrapper seam；测试不启动真实浏览器。
        tencent_response = client.post(
            "/postVideo",
            json={
                "fileList": ["a.mp4"],
                "accountList": ["a.json"],
                "type": 2,
                "title": "tencent",
                "platformFields": {"wechat": {"declaration": "no_label"}},
            },
        )
        assert tencent_response.status_code == 200

        # 官方 batch 抖音调用省略 thumbnail_path；wrapper 应补齐默认尾参数，
        # 同时消费 canonical 声明 payload。
        douyin_response = client.post(
            "/postVideoBatch",
            json=[
                {
                    "fileList": ["a.mp4"],
                    "accountList": ["a.json"],
                    "type": 3,
                    "title": "douyin",
                    "productLink": "https://example.test/product",
                    "productTitle": "商品",
                    "platformFields": {"douyin": {"declaration": "no_need"}},
                }
            ],
        )
        assert douyin_response.status_code == 200

        # 单视频与旧批量对完全相同输入必须经过同一 normalization + execution
        # adapter，并交给官方函数完全相同的 effective command。
        shared_payload = {
            "fileList": ["same.mp4"],
            "accountList": ["a.json"],
            "type": 3,
            "title": "same",
            "tags": ["一致"],
            "category": 2,
            "enableTimer": True,
            "videosPerDay": 1,
            "dailyTimes": [10],
            "startDays": 1,
            "thumbnail": "same-cover.jpg",
            "productLink": "https://example.test/same",
            "productTitle": "同款商品",
            "platformFields": {"douyin": {"declaration": "no_need"}},
        }
        assert client.post("/postVideo", json=shared_payload).status_code == 200
        assert client.post("/postVideoBatch", json=[shared_payload]).status_code == 200

    assert len(xhs_calls) == 1
    assert len(tencent_calls) == 1
    assert len(douyin_calls) == 3
    assert pending_tencent_fields == [{"declaration": "无需标注"}]
    assert douyin_calls[0][0] == ()
    assert douyin_calls[0][1]["thumbnail_path"] == ""
    assert douyin_calls[0][1]["productLink"] == "https://example.test/product"
    assert douyin_calls[0][1]["productTitle"] == "商品"
    assert douyin_calls[1] == douyin_calls[2]
    assert pending_fields == [
        {"declaration": "无需添加自主声明"},
        {"declaration": "无需添加自主声明"},
        {"declaration": "无需添加自主声明"},
    ]

    # 代理只负责把声明交给官方上传类，不复制官方发布循环。
    with uploader_wrapper._declaration_context(
        {"platform": 3, "douyin": {"declaration": "无需添加自主声明"}}
    ):
        douyin_video = uploader_wrapper._DouYinVideoWithDeclaration(
            "title", "file.mp4", [], 0, "account.json"
        )
    assert douyin_video.declaration == "无需添加自主声明"

    with uploader_wrapper._declaration_context(
        {"platform": 2, "tencent": {"declaration": "无需标注"}}
    ):
        tencent_video = uploader_wrapper._TencentVideoWithDeclaration(
            "title", "file.mp4", [], 0, "account.json"
        )
    assert tencent_video.posthub_declaration == "无需标注"

    assert {
        "/getAccountDefaults",
        "/updateAccountDefaults",
    } <= {rule.rule for rule in first.url_map.iter_rules()}

    with sqlite3.connect(db_path) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {"user_info", "file_records"} <= tables
    assert not (unselected_base / "db" / "database.db").exists()
