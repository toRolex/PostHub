"""database.db 初始化专项测试（ticket 03）：建库 / 幂等跳过不破坏 / 可写入。

测试全部落在 pytest tmp_path，不触碰仓库 daemon/db/（.gitignore 已排除）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import db_init


def _table_names(db_path: Path) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }


def test_ensure_db_creates_database_and_schema(tmp_path: Path) -> None:
    db_path = db_init.ensure_db(db_path=tmp_path / "db" / "database.db")
    assert db_path.exists()
    assert {"user_info", "file_records"} <= _table_names(db_path)


def test_ensure_db_defaults_to_official_location() -> None:
    assert db_init.default_db_path() == db_init.conf.load_conf().BASE_DIR / "db" / "database.db"


def test_ensure_db_is_idempotent_and_preserves_data(tmp_path: Path) -> None:
    db_path = db_init.ensure_db(db_path=tmp_path / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName) VALUES (1, 'a.json', '主播')"
        )
        conn.commit()

    # 重复初始化：已存在有效库 → 跳过，不重建、不丢行
    assert db_init.ensure_db(db_path=db_path) == db_path
    assert {"user_info", "file_records"} <= _table_names(db_path)
    with sqlite3.connect(db_path) as conn:
        rows = list(conn.execute("SELECT * FROM user_info"))
    assert len(rows) == 1
    assert rows[0][3] == "主播"


def test_ensure_db_tables_writable(tmp_path: Path) -> None:
    """smoke：库初始化后两张官方表均可写入（后端各路由的读写前提）。"""
    db_path = db_init.ensure_db(db_path=tmp_path / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName) VALUES (1, 'a.json', 'accA')"
        )
        conn.execute(
            "INSERT INTO file_records (filename, filesize, file_path) VALUES ('v.mp4', 12.5, 'uuid_v.mp4')"
        )
        conn.commit()

    with sqlite3.connect(db_path) as conn:
        n_accounts = conn.execute("SELECT COUNT(*) FROM user_info").fetchone()[0]
        files = list(
            conn.execute("SELECT filename, filesize, file_path FROM file_records")
        )
    assert n_accounts == 1
    assert files == [("v.mp4", 12.5, "uuid_v.mp4")]