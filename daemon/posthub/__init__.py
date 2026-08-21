"""PostHub Python 依赖包。

`__version__` 与桌面安装包版本保持一致（`src-tauri/tauri.conf.json` 的 `version`）。
前端左下角版本号读取 `/health` 返回的此值，发版时需同步 bump（见 docs/deployment.md 发布流程）。
"""

__version__ = "0.1.7"