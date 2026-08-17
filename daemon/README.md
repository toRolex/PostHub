# PostHub daemon

PostHub 的 Python 依赖薄层（uv 管理）。当前只保留官方后端依赖所需的最小配置：

- `conf` 模块：上游 `social-auto-upload` 执行 `import conf` 所需的 6 个配置符号 + 字段校验
  （`BASE_DIR` 为 `pathlib.Path`，上游 `uploader/*/__init__.py` 依赖 `BASE_DIR / "cookies"`）
- `utils/stealth.min.js`：上游依赖产物

## 开发

```bash
uv sync            # 创建 .venv 并安装依赖（social-auto-upload 经 git 安装）
uv run pytest      # 测试（当前仅 conf 六符号校验）
```

> 上游 `social-auto-upload` 要求 Python `>=3.10,<3.13`，本项目 `daemon/.python-version` 固定 3.11。
