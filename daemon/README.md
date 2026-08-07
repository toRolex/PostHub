# PostHub 守护进程

PostHub 的常驻 Python 守护进程（uv 管理）。提供：

- 本地 HTTP IPC（默认 `http://127.0.0.1:8756`），`GET /health` 健康检查
- `conf` 模块：发布引擎（social-auto-upload）依赖的 6 个配置符号 + 字段校验
- 任务执行引擎 seam：`execute(task_spec, context) -> job_updates`（fake 浏览器执行器注入）

## 开发

```bash
uv sync            # 创建 .venv 并安装 dev 依赖（pytest）
uv run pytest      # 全量测试
uv run python -m posthub   # 启动守护进程（默认 8756 端口）
```
