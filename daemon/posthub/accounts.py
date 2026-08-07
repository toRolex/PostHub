"""账号存储服务（ADR-0001 `account` 表）。

账号 = 单平台 + 单台本机 Chrome（独立 `user-data-dir` + 独立调试端口 `cdp_port`）。
本模块是账号管理的存储 seam：InMemory 与 SQLite 实现可互换，测试注入任一种。

表结构（ADR-0001，权威）：

    CREATE TABLE account (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        platform      TEXT    NOT NULL CHECK (platform IN ('douyin','xiaohongshu','wechat')),
        name          TEXT    NOT NULL,                -- 显示名/备注
        profile_dir   TEXT    NOT NULL,                -- Chrome user-data-dir 绝对路径
        cdp_port      INTEGER NOT NULL,                -- 独立调试端口，cdp_url = http://127.0.0.1:{cdp_port}
        chrome_path   TEXT,                            -- 可选；固定 Chrome/Edge 可执行文件路径
        status        TEXT    NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','needs_relogin','disabled')),
        last_login_at TEXT,
        last_publish_at TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE (platform, cdp_port)
    );
"""

from __future__ import annotations

import dataclasses
import os
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

Platform = Literal["douyin", "xiaohongshu", "wechat"]
AccountStatus = Literal["active", "needs_relogin", "disabled"]

__all__ = [
    "Platform",
    "AccountStatus",
    "Account",
    "NewAccount",
    "AccountStore",
    "AccountConflictError",
    "InMemoryAccountStore",
    "SqliteAccountStore",
    "now_str",
    "default_data_dir",
    "default_db_path",
    "default_profile_dir",
]


def now_str() -> str:
    """本地时间 ISO8601 字符串（`YYYY-MM-DD HH:MM:SS`，CONTEXT.md 命名约定）。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def default_data_dir() -> Path:
    """应用数据目录：`POSTHUB_DATA_DIR` 环境变量优先，否则 `~/.posthub`。"""
    env = os.environ.get("POSTHUB_DATA_DIR")
    return Path(env) if env else Path.home() / ".posthub"


def default_db_path() -> str:
    """默认 SQLite 数据库路径（账号持久化）。"""
    return str(default_data_dir() / "posthub.db")


def default_profile_dir() -> str:
    """默认 Chrome 独立 user-data-dir 的根目录。"""
    return str(default_data_dir() / "profiles")


@dataclass(frozen=True)
class Account:
    """一条账号记录（与 ADR-0001 `account` 表行一一对应）。"""

    id: int
    platform: Platform
    name: str
    profile_dir: str
    cdp_port: int
    chrome_path: str | None
    status: AccountStatus
    last_login_at: str | None
    last_publish_at: str | None
    created_at: str
    updated_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "platform": self.platform,
            "name": self.name,
            "profile_dir": self.profile_dir,
            "cdp_port": self.cdp_port,
            "chrome_path": self.chrome_path,
            "status": self.status,
            "last_login_at": self.last_login_at,
            "last_publish_at": self.last_publish_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class NewAccount:
    """创建账号的入参（id / 时间戳由存储层赋值）。"""

    platform: Platform
    name: str
    profile_dir: str
    cdp_port: int
    chrome_path: str | None = None
    status: AccountStatus = "active"


class AccountConflictError(Exception):
    """`UNIQUE (platform, cdp_port)` 冲突。"""


class AccountStore(Protocol):
    """账号存储 seam：CRUD + 唯一约束 + 状态字段。InMemory / SQLite 可互换。"""

    def create(self, new: NewAccount) -> Account:
        ...

    def list(self) -> list[Account]:
        ...

    def get(self, account_id: int) -> Account | None:
        ...

    def delete(self, account_id: int) -> bool:
        ...

    def set_status(self, account_id: int, status: AccountStatus) -> bool:
        """更新账号状态（调度器在 job → needs_relogin 时顺带置位）。"""

    def set_last_publish_at(self, account_id: int, ts: str) -> bool:
        """回写账号最近发布时间（限速 5 分钟的判定依据）。"""

    def close(self) -> None:
        ...


class InMemoryAccountStore:
    """内存实现：测试用，与 SqliteAccountStore 行为一致。"""

    def __init__(self) -> None:
        self._rows: dict[int, Account] = {}
        self._next_id = 1
        self._lock = threading.Lock()

    def create(self, new: NewAccount) -> Account:
        with self._lock:
            for acc in self._rows.values():
                if acc.platform == new.platform and acc.cdp_port == new.cdp_port:
                    raise AccountConflictError(
                        f"platform={new.platform} cdp_port={new.cdp_port} 已存在"
                    )
            ts = now_str()
            acc = Account(
                id=self._next_id,
                platform=new.platform,
                name=new.name,
                profile_dir=new.profile_dir,
                cdp_port=new.cdp_port,
                chrome_path=new.chrome_path,
                status=new.status,
                last_login_at=None,
                last_publish_at=None,
                created_at=ts,
                updated_at=ts,
            )
            self._rows[self._next_id] = acc
            self._next_id += 1
            return acc

    def list(self) -> list[Account]:
        with self._lock:
            return list(self._rows.values())

    def get(self, account_id: int) -> Account | None:
        with self._lock:
            return self._rows.get(account_id)

    def delete(self, account_id: int) -> bool:
        with self._lock:
            return self._rows.pop(account_id, None) is not None

    def set_status(self, account_id: int, status: AccountStatus) -> bool:
        with self._lock:
            acc = self._rows.get(account_id)
            if acc is None:
                return False
            ts = now_str()
            self._rows[account_id] = dataclasses.replace(acc, status=status, updated_at=ts)
            return True

    def set_last_publish_at(self, account_id: int, ts: str) -> bool:
        with self._lock:
            acc = self._rows.get(account_id)
            if acc is None:
                return False
            self._rows[account_id] = dataclasses.replace(
                acc, last_publish_at=ts, updated_at=ts
            )
            return True

    def close(self) -> None:
        pass


class SqliteAccountStore:
    """SQLite 实现：持久化账号记录（重启不丢，登录态保持的存储前提）。"""

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        self._lock = threading.Lock()
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False：ThreadingHTTPServer 每请求在独立线程执行，
        # 但所有读写都经 self._lock 串行化，连接可跨线程复用。
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._create_schema()

    def _create_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS account (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform        TEXT    NOT NULL
                        CHECK (platform IN ('douyin','xiaohongshu','wechat')),
                    name            TEXT    NOT NULL,
                    profile_dir     TEXT    NOT NULL,
                    cdp_port        INTEGER NOT NULL,
                    chrome_path     TEXT,
                    status          TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','needs_relogin','disabled')),
                    last_login_at   TEXT,
                    last_publish_at TEXT,
                    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    UNIQUE (platform, cdp_port)
                );
                """
            )
            self._conn.commit()

    def _fetch(self, account_id: int) -> sqlite3.Row | None:
        cur = self._conn.execute(
            "SELECT * FROM account WHERE id = ?", (account_id,)
        )
        return cur.fetchone()

    @staticmethod
    def _row_to_account(row: sqlite3.Row) -> Account:
        return Account(
            id=row["id"],
            platform=row["platform"],
            name=row["name"],
            profile_dir=row["profile_dir"],
            cdp_port=row["cdp_port"],
            chrome_path=row["chrome_path"],
            status=row["status"],
            last_login_at=row["last_login_at"],
            last_publish_at=row["last_publish_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def create(self, new: NewAccount) -> Account:
        with self._lock:
            ts = now_str()
            try:
                cur = self._conn.execute(
                    """
                    INSERT INTO account
                        (platform, name, profile_dir, cdp_port, chrome_path, status,
                         last_login_at, last_publish_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                    """,
                    (
                        new.platform,
                        new.name,
                        new.profile_dir,
                        new.cdp_port,
                        new.chrome_path,
                        new.status,
                        ts,
                        ts,
                    ),
                )
                self._conn.commit()
            except sqlite3.IntegrityError as exc:
                raise AccountConflictError(
                    f"platform={new.platform} cdp_port={new.cdp_port} 已存在"
                ) from exc
            row = self._fetch(cur.lastrowid)
            assert row is not None
            return self._row_to_account(row)

    def list(self) -> list[Account]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM account ORDER BY id ASC"
            )
            return [self._row_to_account(row) for row in cur.fetchall()]

    def get(self, account_id: int) -> Account | None:
        with self._lock:
            row = self._fetch(account_id)
            return self._row_to_account(row) if row is not None else None

    def delete(self, account_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM account WHERE id = ?", (account_id,)
            )
            self._conn.commit()
            return cur.rowcount > 0

    def set_status(self, account_id: int, status: AccountStatus) -> bool:
        with self._lock:
            ts = now_str()
            cur = self._conn.execute(
                "UPDATE account SET status = ?, updated_at = ? WHERE id = ?",
                (status, ts, account_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def set_last_publish_at(self, account_id: int, ts: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE account SET last_publish_at = ?, updated_at = ? WHERE id = ?",
                (ts, ts, account_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()
