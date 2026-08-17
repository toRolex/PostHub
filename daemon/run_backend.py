"""官方后端 launcher：以本机回环地址启动上游 sau_backend，不改官方源码。

官方 `sau_backend.py` 的 `__main__` 是 `app.run(host='0.0.0.0', port=5409)`，
会暴露到局域网（ADR-0006「待确认」安全项）。本模块在 import 官方模块后、
run 之前把 host 覆盖为 `127.0.0.1`，其余行为与官方 `__main__` 一致。

官方源码来源：social-auto-upload commit 008e4ff66abdf48eb1f4b999272ef979711af436
（sha256 6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d），
逐字节拷贝为 `daemon/sau_backend.py`，未做任何修改（见 daemon/README.md）。

启动前幂等初始化官方 database.db（ADR-0006 待办「首次启动自动建库」→ ticket 03）：
官方后续版本要求手工建库，`/getAccounts`、`/uploadSave` 等路由
`sqlite3.connect(BASE_DIR/db/database.db)`，db 目录/表不存在会崩。这里复用
`db_init.ensure_db` 建 `user_info` / `file_records` 两表（DDL 取自上游
`db/createTable.py`），已存在有效库时跳过、不破坏数据。
"""

from __future__ import annotations

import sys
from pathlib import Path

_DAEMON_DIR = Path(__file__).resolve().parent
if str(_DAEMON_DIR) not in sys.path:
    # 让 `import conf` 解析到 PostHub 的 daemon/conf.py
    sys.path.insert(0, str(_DAEMON_DIR))

import db_init  # noqa: E402  # 建库模块；其顶层 `import conf` 触发配置校验（上游依赖解析）


db_init.ensure_db()

import sau_backend  # noqa: E402  # 官方主入口（原样）

# 官方 `__main__` 是 app.run(host='0.0.0.0', port=5409)；
# 仅监听 127.0.0.1:5409，不暴露局域网（ADR-0006 安全项）。
sau_backend.app.run(host="127.0.0.1", port=5409)