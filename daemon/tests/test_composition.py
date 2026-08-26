"""PostHub-owned 组合入口契约测试。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import sau_backend
from posthub.composition import compose_official_backend


def _rule_count(app, path: str) -> int:
    return sum(1 for rule in app.url_map.iter_rules() if rule.rule == path)


def test_repeated_composition_is_idempotent_and_preserves_official_http_seam(
    monkeypatch, tmp_path: Path
) -> None:
    """重复组合只注册一次 PostHub 扩展，官方账号/素材/单视频/批量接口仍可用。"""
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    db_path = tmp_path / "db" / "database.db"

    first = compose_official_backend(db_path=db_path)
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

    assert second is first
    assert route_counts["/getAccountDefaults"] == 1
    assert route_counts["/updateAccountDefaults"] == 1
    assert route_counts["/getAccounts"] == 1
    assert route_counts["/getFiles"] == 1
    assert route_counts["/postVideo"] == 1
    assert route_counts["/postVideoBatch"] == 1
    assert {
        "/getAccountDefaults",
        "/updateAccountDefaults",
    } <= {rule.rule for rule in first.url_map.iter_rules()}

    with first.test_client() as client:
        assert client.get("/getAccounts").status_code == 200
        assert client.get("/getFiles").status_code == 200
        assert client.post("/postVideo", json={}).status_code == 400
        assert client.post("/postVideoBatch", json={}).status_code == 400

    with sqlite3.connect(db_path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert {"user_info", "file_records"} <= tables
