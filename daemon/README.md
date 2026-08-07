# PostHub 守护进程

PostHub 的常驻 Python 守护进程（uv 管理）。提供：

- 本地 HTTP IPC（默认 `http://127.0.0.1:8756`）
  - `GET /health` 健康检查
  - `GET /conf` 上游 conf 六符号
  - `GET /accounts` 账号列表
  - `POST /accounts` 添加账号（落库 + 拉起独立 Chrome 扫码登录）
  - `DELETE /accounts/{id}` 删除账号（移除记录 + 尽力清理关联 Chrome）
- `conf` 模块：发布引擎（social-auto-upload）依赖的 6 个配置符号 + 字段校验
- 任务执行引擎 seam：`execute(task_spec, context) -> job_updates`（fake 浏览器执行器注入）
- `accounts` 模块：账号存储 seam（`account` 表 CRUD + 平台/端口唯一约束；InMemory 与 SQLite 实现可互换）
- `chrome_launcher` 模块：为账号拉起独立本机 Chrome（独立 `user-data-dir` + 独立调试端口 + `--remote-allow-origins=*`）

数据持久化在 `POSTHUB_DATA_DIR`（默认 `~/.posthub`）：`posthub.db`（账号表）+ `profiles/`（Chrome 独立 profile）。

## 开发

```bash
uv sync            # 创建 .venv 并安装 dev 依赖（pytest）
uv run pytest      # 全量测试
uv run python -m posthub   # 启动守护进程（默认 8756 端口）
```
