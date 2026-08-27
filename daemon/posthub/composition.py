"""PostHub 后端独立组合入口。

组合入口负责把官方 Flask 应用与 PostHub-owned 扩展拼接起来：数据库初始化、
扩展路由、发布 seam 生命周期钩子和上游调用包装都在这里注册。官方
``sau_backend.py`` 不承担这些组合职责，也不被复制修改。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import db_init
from posthub.routes import register_declaration_hooks, register_posthub_routes
from posthub.uploader_wrapper import install as install_uploader_wrapper

_COMPOSITION_MARKER = "_posthub_composition"


def _configure_official_base_dir(base_dir: Path) -> None:
    """让已导入的官方模块共同使用显式 db_path 所属数据目录。

    上游模块通过 ``from conf import BASE_DIR`` 捕获值，单独修改 conf 模块
    不会影响已导入路由。因此在组合边界集中更新这些运行时引用，而不修改
    上游源文件；官方路由与 PostHub 路由随后都解析到同一个 database.db。
    """
    import myUtils.auth as official_auth
    import myUtils.login as official_login
    import myUtils.postVideo as official_post_video
    import uploader.douyin_uploader.main as douyin_main
    import uploader.tencent_uploader.main as tencent_main

    import conf
    import sau_backend

    conf.BASE_DIR = base_dir
    for module in (
        official_auth,
        official_login,
        official_post_video,
        sau_backend,
        douyin_main,
        tencent_main,
    ):
        module.BASE_DIR = base_dir


def compose_posthub_backend(app: Any, db_path: Path | str) -> Any:
    """在指定 Flask 应用上一次性组合 PostHub-owned 生命周期与路由。"""
    path = Path(db_path).resolve()
    existing = getattr(app, "extensions", {}).get(_COMPOSITION_MARKER)
    if existing is not None:
        existing_path = existing.get("db_path")
        if existing_path != path:
            raise ValueError(
                "同一 Flask app 不允许组合到不同数据库；"
                f"已绑定 {existing_path}，请求 {path}"
            )
        return app

    _configure_official_base_dir(path.parent.parent)
    db_init.ensure_db(db_path=path)
    install_uploader_wrapper()
    register_posthub_routes(app, path)
    register_declaration_hooks(app, path)
    app.extensions[_COMPOSITION_MARKER] = {"db_path": path}
    return app


def compose_official_backend(db_path: Path | str | None = None) -> Any:
    """导入官方应用并返回已组合的 Flask app；重复调用返回同一实例。"""
    import sau_backend

    path = Path(db_path) if db_path is not None else db_init.default_db_path()
    return compose_posthub_backend(sau_backend.app, path)
