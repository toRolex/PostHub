"""官方后端 launcher：以本机回环地址启动上游 sau_backend，不改官方源码。

官方 `sau_backend.py` 的 `__main__` 是 `app.run(host='0.0.0.0', port=5409)`，
会暴露到局域网（ADR-0006「待确认」安全项）。本模块在 import 官方模块后、
run 之前把 host 覆盖为 `127.0.0.1`，其余行为与官方 `__main__` 一致。

官方源码来源：social-auto-upload commit 008e4ff66abdf48eb1f4b999272ef979711af436
（sha256 6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d），
逐字节拷贝为 `daemon/sau_backend.py`，未做任何修改（见 daemon/README.md）。

启动前幂等初始化 SQLite（ADR-0006 待办「首次启动自动建库」）：官方后续版本要求
手工建库，`/getAccounts` 等路由 `sqlite3.connect(BASE_DIR/db/database.db)`，db 目录
不存在会崩。这里按上游 `db/createTable.py` 的 DDL 建 `user_info` 表。
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_DAEMON_DIR = Path(__file__).resolve().parent
if str(_DAEMON_DIR) not in sys.path:
    # 让 `import conf` 解析到 PostHub 的 daemon/conf.py
    sys.path.insert(0, str(_DAEMON_DIR))

import conf  # noqa: E402  # 先建 conf 模块（上游依赖解析），并触发配置校验

HOST = "127.0.0.1"
PORT = 5409


def _ensure_schema() -> None:
    """幂等创建 db 目录与 user_info 表（DDL 取自上游 db/createTable.py）。"""
    db_dir = conf.load_conf().BASE_DIR / "db"
    db_dir.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_dir / "database.db") as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_info (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type INTEGER NOT NULL,
                filePath TEXT NOT NULL,
                userName TEXT NOT NULL,
                status INTEGER DEFAULT 0
            )
            """
        )


_ensure_schema()

import sau_backend  # noqa: E402  # 官方主入口（原样）

# 官方 `__main__` 是 app.run(host='0.0.0.0', port=5409)；
# 仅监听 127.0.0.1:5409，不暴露局域网（ADR-0006 安全项）。
sau_backend.app.run(host=HOST, port=PORT)
