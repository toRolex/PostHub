# PostHub 守护进程

PostHub 的常驻 Python 守护进程（uv 管理）。提供：

- 本地 HTTP IPC（默认 `http://127.0.0.1:8756`）
  - `GET /health` 健康检查
  - `GET /conf` 上游 conf 六符号
  - `GET /accounts` 账号列表
  - `POST /accounts` 添加账号（落库 + 拉起独立 Chrome 扫码登录）
  - `DELETE /accounts/{id}` 删除账号（移除记录 + 尽力清理关联 Chrome）
- `conf` 模块：发布引擎（social-auto-upload）依赖的 6 个配置符号 + 字段校验
  （`BASE_DIR` 为 `pathlib.Path`，上游 `uploader/*/__init__.py` 依赖 `BASE_DIR / "cookies"`）
- 任务执行引擎 seam：`execute(task_spec, context) -> job_updates`（fake 浏览器执行器注入）
- `accounts` 模块：账号存储 seam（`account` 表 CRUD + 平台/端口唯一约束；InMemory 与 SQLite 实现可互换）
- `chrome_launcher` 模块：为账号拉起独立本机 Chrome（独立 `user-data-dir` + 独立调试端口 + `--remote-allow-origins=*`）
- `cdp_attach` 模块（#20）：CDP 接管 wrapper——patch `chromium.launch` → `connect_over_cdp` 接管账号
  Chrome、复用已连接 context（登录态持久化）、中和 `browser.close()`/`context.close()`（不关闭真实 Chrome）
- `uploader` 模块（#20）：`build_uploader(platform, spec)` 按平台实例化上游
  DouYinVideo / XiaoHongShuVideo / TencentVideo；`UpstreamUploadExecutor` 接
  `cdp_attach` 完成「选视频 → 填信息 → 上传」最小发布链路

数据持久化在 `POSTHUB_DATA_DIR`（默认 `~/.posthub`）：`posthub.db`（账号表）+ `profiles/`（Chrome 独立 profile）。

## Phase 1（issue #20）就绪状态

- **已验证（本机冒烟）**：`chrome_launcher` 拉起真实 Chrome → `cdp_attach` 经 `connect_over_cdp`
  接管成功、context 复用（`context == browser.contexts[0]`）、`browser.close()` 后真实 Chrome 存活。
- **代码就绪，留待 #11**：真实平台 upload 链路（需真实账号登录态 + 平台 UI）——wrapper 与
  执行链单测已覆盖，真实上传属验收门 #11。
- 注意：本机 shell 若配置了 `http_proxy`，`cdp_attach(is_local=True)` 会本地直连
  `/json/version` 解析 `ws://` 端点再交给 `connect_over_cdp`，绕过驱动走代理导致的 400。

## 开发

```bash
uv sync            # 创建 .venv 并安装 dev 依赖（pytest；social-auto-upload 经 git 安装）
uv run pytest      # 全量测试
uv run python -m posthub   # 启动守护进程（默认 8756 端口）
```

> 上游 `social-auto-upload` 要求 Python `>=3.10,<3.13`，本项目 `daemon/.python-version` 固定 3.11。
