"""官方后端 launcher：经 PostHub 独立组合入口启动本机官方后端。

官方 `sau_backend.py` 保持上游副本；`posthub.composition` 在其外部一次性
组合 PostHub-owned 路由、数据库初始化、声明 seam 与生命周期钩子。官方
`__main__` 的 `0.0.0.0` 监听仍由本 launcher 收紧为 `127.0.0.1`。

官方源码来源：social-auto-upload commit 008e4ff66abdf48eb1f4b999272ef979711af436
（sha256 6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d），
逐字节拷贝为 `daemon/sau_backend.py`，未做任何修改（见 daemon/README.md）。
"""

from __future__ import annotations

import sys
from pathlib import Path

_DAEMON_DIR = Path(__file__).resolve().parent
if str(_DAEMON_DIR) not in sys.path:
    # 让 `import conf` 解析到 PostHub 的 daemon/conf.py
    sys.path.insert(0, str(_DAEMON_DIR))

from posthub.composition import compose_official_backend

HOST = "127.0.0.1"
PORT = 5409


app = compose_official_backend()

# 官方 `__main__` 是 app.run(host='0.0.0.0', port=5409)；
# 仅监听 127.0.0.1:5409，不暴露局域网（ADR-0006 安全项）。
app.run(host=HOST, port=PORT)
