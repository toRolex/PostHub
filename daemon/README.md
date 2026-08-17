# PostHub daemon

PostHub 的 Python 依赖薄层（uv 管理）。当前是官方 `social-auto-upload` 后端的薄封装：

- `conf` 模块：上游执行 `import conf` 所需的 6 个配置符号 + 字段校验
  （`BASE_DIR` 为 `pathlib.Path`，上游 `uploader/*/__init__.py` 依赖 `BASE_DIR / "cookies"`）
- `sau_backend.py`：官方 Flask 主入口（`/getAccounts`、`/login`、`/postVideo` 等），**原样拷贝自上游**
- `run_backend.py`：PostHub 侧 launcher（改监听 127.0.0.1，起后台前自动建 SQLite）
- `utils/stealth.min.js`：上游依赖产物

## 官方后端落地方式（不 fork / 不改官方源码）

官方 `social-auto-upload` 的 git 依赖安装进 `.venv` 后，**缺少 `sau_backend.py` 与顶层 `conf.py`**
（wheel 化构建的 `py-modules` 声明了 `conf`，但源码被替换为 `conf.example.py`；`sau_backend.py`
从未被 `packages.find` 收进 wheel，只随仓库存在）。

PostHub 侧以「**从上游仓库拷贝 + 来源 hash 记档**」方式补齐两个符号，不改官方文件：

| 文件 | 来源 | 校验 |
|------|------|------|
| `daemon/sau_backend.py` | 上游仓库 `sau_backend.py` @ commit <code>008e4ff66abdf48eb1f4b999272ef979711af436</code>，逐字节原样拷贝 | sha256 `6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d` |
| `daemon/conf.py` | PostHub 自备（既有），默认值与上游一致，经 `POSTHUB_` 前缀环境变量加载 | 见 `tests/test_conf.py` |

> 校验命令：`shasum -a 256 daemon/sau_backend.py` 应等于上表 sha256。

### conf 集成方式

`sau_backend.py` 顶层 `from conf import BASE_DIR` 需要一个同名顶层模块。`run_backend.py` 在
import 官方模块之前把 `daemon/` 根目录插入 `sys.path`，使 `import conf`（官方、`myUtils`、
`uploader/*` 内部同样 `from conf import ...`）统一解析到 PostHub 的 `daemon/conf.py`。

### 依赖补齐（官方主依赖缺失项）

`social-auto-upload` 的主依赖仅含 patchright 等发布驱动，**不含 Flask/flask-cors/playwright/xhs**
（均在上游 `requirements.txt` / `web` extra 中），但官方后端顶层 import 需要。PostHub 在
`pyproject.toml` 显式补齐并锁定版本：

| 依赖 | 版本 | 理由 |
|------|------|------|
| `Flask[async]` | 3.1.1 | `sau_backend.py` Flask 主入口；上游 `web` extra |
| `flask-cors` | 6.0.0 | `sau_backend.py` `CORS(app)`；上游 `web` extra |
| `playwright` | 1.52.0 | `myUtils/auth.py` 顶层 `from playwright.async_api import async_playwright`（上游主依赖换 patchright 但源码仍 import playwright 名） |
| `xhs` | 0.2.13 | `myUtils/auth.py` 顶层 `from xhs import XhsClient` |

## 启动官方后端

```bash
uv sync            # 安装依赖（含上述补齐项）
uv run python run_backend.py
```

启动后仅监听 `127.0.0.1:5409`（不暴露局域网；官方默认 `0.0.0.0` 的收紧见 ADR-0006 待确认项）。
首次启动自动创建 `db/database.db` 与 `user_info` 表（幂等）。

## 就绪探针轮询策略

不依赖 `/health`（官方后端无此路由）。PostHub 侧用以下两项组合判定后端就绪：

1. **TCP connect** `127.0.0.1:5409` 成功；
2. **GET `http://127.0.0.1:5409/getAccounts` 返回 HTTP 200**。

轮询间隔 0.5s，超时 20s。两项同时满足才算就绪。实现在
`tests/test_backend_contract.py::_wait_ready`，桌面壳启动后可按同样策略探活。

## 验证

```bash
uv run pytest      # 9 passed（conf 六符号校验 + 官方后端 seam 契约 smoke）
```

契约 smoke：启动官方后端 → 探活 → `/getAccounts` 断言 200 + 官方 `code` 字段 → 停后端。