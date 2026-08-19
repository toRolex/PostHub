"""官方 database.db 幂等初始化：独立模块，供 run_backend 与测试共用。

官方后续版本要求手工建库（`db/createTable.py`），`/getAccounts`、`/uploadSave`、
`/getFiles`、`/deleteFile` 等路由 `sqlite3.connect(BASE_DIR/db/database.db)`，
db 目录或表缺失会崩。本模块把该运维步骤封装为幂等 `ensure_db`：
db/表不存在则建，已存在有效库则跳过，不破坏既有数据（ticket 03）。

同时预建官方**不自动创建**的数据目录：官方 `uploader/*/__init__.py` 只自建
`cookies/`，`myUtils/login.py` 只自建 `cookiesFile/`，而 `/uploadSave` 直接
`file.save(BASE_DIR/videoFile/...)` 不建目录——首次上传素材即抛
`[Errno 2] No such file or directory`（生产机实测）。运行前补齐
`videoFile/`，发布链路（`myUtils/postVideo.py` 读 `BASE_DIR/videoFile`）同样受益。

建表 DDL 来源：上游 social-auto-upload @ commit
008e4ff66abdf48eb1f4b999272ef979711af436 的 `db/createTable.py`，原样提取
（列、类型、默认值、约束与官方一致）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import conf  # 触发配置校验并读取默认 BASE_DIR（调用路径须保证 daemon/ 在 sys.path）

# 官方结构（来源：上游 db/createTable.py，两段 CREATE TABLE 原样提取）
CREATE_USER_INFO = """
CREATE TABLE IF NOT EXISTS user_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type INTEGER NOT NULL,
    filePath TEXT NOT NULL,
    userName TEXT NOT NULL,
    status INTEGER DEFAULT 0
)
"""

CREATE_FILE_RECORDS = """
CREATE TABLE IF NOT EXISTS file_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    filesize REAL,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_path TEXT
)
"""

_CREATE_TABLES = (CREATE_USER_INFO, CREATE_FILE_RECORDS)


# 官方写入数据但**不自动创建**的目录（官方自建只到 cookies/ 与 cookiesFile/）；
# 缺失会导致 /uploadSave 抛 [Errno 2]。运行时补齐（PowerShell Copy-Item 语义幂等）。
DATA_DIRS = ("videoFile",)


def default_db_path() -> Path:
    """官方约定的库路径：BASE_DIR/db/database.db（默认 BASE_DIR = 本 daemon 目录）。"""
    return conf.load_conf().BASE_DIR / "db" / "database.db"


def ensure_db(db_path: Path | str | None = None) -> Path:
    """幂等确保官方 database.db 与 user_info / file_records 两表就绪，返回库文件路径。

    - db 目录/文件不存在 → 创建；表缺失 → 补齐（CREATE TABLE IF NOT EXISTS）。
    - database.db 已存在且表就绪 → 原样跳过，不重建、不删行、不动结构。
    - 官方不自动建的数据目录（videoFile/）一并补齐。
    """
    path = Path(db_path) if db_path is not None else default_db_path()
    base = path.parent.parent
    path.parent.mkdir(parents=True, exist_ok=True)
    for name in DATA_DIRS:
        (base / name).mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        for ddl in _CREATE_TABLES:
            conn.execute(ddl)
    return path
