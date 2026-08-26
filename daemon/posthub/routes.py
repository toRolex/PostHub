"""PostHub-owned Flask 扩展路由与官方发布 seam 适配。

本模块只在组合入口中注册：官方 ``sau_backend.py`` 保持上游副本，PostHub
扩展通过 Flask 生命周期钩子和独立路由接入，不把自研能力继续堆进官方模块。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

from posthub.declarations import (
    DeclarationMappingError,
    resolve_platform_fields,
    select_for_platform,
)
from posthub.uploader_wrapper import set_pending_declarations

_ROUTE_MARKER = "_posthub_owned_routes_registered"
_HOOK_MARKER = "_posthub_declaration_hooks_registered"
_PLATFORM_NAMES = {1: "xiaohongshu", 2: "wechat", 3: "douyin"}
_PLATFORM_FIELD_KEYS = {
    1: {"source", "origin"},
    2: {"declaration", "origin"},
    3: {"declaration"},
}


def _load_account_defaults_map(db_path: Path) -> dict[str, dict]:
    """从官方 user_info 读取账号默认声明；旧库缺列时按空配置处理。"""
    out: dict[str, dict] = {}
    with sqlite3.connect(db_path) as conn:
        try:
            rows = conn.execute(
                "SELECT filePath, default_platform_fields FROM user_info"
            ).fetchall()
        except sqlite3.OperationalError:
            return out
    for file_path, raw in rows:
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict):
            out[file_path] = parsed
    return out


def _merge_platform_fields(
    task_fields: dict | None,
    accounts_with_defaults: list[dict[str, Any]],
) -> dict:
    """任务级声明覆盖账号默认声明，缺失字段从账号默认值补齐。"""
    base: dict = {}
    for account in accounts_with_defaults:
        defaults = account.get("default_platform_fields")
        if not isinstance(defaults, dict):
            continue
        for platform, fields in defaults.items():
            if not isinstance(fields, dict):
                continue
            base.setdefault(platform, {})
            for key, value in fields.items():
                base[platform].setdefault(key, value)

    if not task_fields:
        return base
    for platform, fields in task_fields.items():
        if not isinstance(fields, dict):
            continue
        base.setdefault(platform, {})
        for key, value in fields.items():
            if value is not None:
                base[platform][key] = value
    return base


def _validate_platform_fields(platform_fields: dict | None, platform: int) -> None:
    """校验 PostHub 平台字段形状，非法时返回可读的 400 错误。"""
    if not platform_fields or platform not in _PLATFORM_NAMES:
        return
    section = platform_fields.get(_PLATFORM_NAMES[platform])
    if not isinstance(section, dict):
        return
    unknown = set(section) - _PLATFORM_FIELD_KEYS[platform]
    if unknown:
        raise DeclarationMappingError(
            f"{_PLATFORM_NAMES[platform]} 字段非法：{sorted(unknown)}"
            f"（合法子键：{sorted(_PLATFORM_FIELD_KEYS[platform])}）"
        )


def _declaration_item(
    payload: dict[str, Any],
    defaults_map: dict[str, dict],
) -> dict[str, Any]:
    platform = payload.get("type")
    account_list = payload.get("accountList", [])
    platform_fields = payload.get("platformFields") or payload.get("platform_fields")
    _validate_platform_fields(platform_fields, platform)
    accounts_with_defaults = [
        {"filePath": file_path, "default_platform_fields": defaults_map.get(file_path)}
        for file_path in account_list
    ]
    merged = _merge_platform_fields(platform_fields, accounts_with_defaults)
    if not merged:
        return {"platform": platform}
    resolved = resolve_platform_fields(merged)
    return {"platform": platform, **select_for_platform(resolved, platform)}


def register_declaration_hooks(app: Flask, db_path: Path) -> None:
    """注册官方发布路由所需的 PostHub 声明适配钩子，重复调用无副作用。"""
    if app.extensions.get(_HOOK_MARKER):
        return

    @app.before_request
    def prepare_posthub_declarations():
        if request.endpoint not in {"postVideo", "postVideoBatch"}:
            return None

        payload = request.get_json(silent=True)
        if request.endpoint == "postVideoBatch":
            if not isinstance(payload, list):
                return None
            items = payload
        else:
            if not isinstance(payload, dict):
                return None
            items = [payload]

        try:
            defaults_map = _load_account_defaults_map(db_path)
            set_pending_declarations(
                [_declaration_item(item, defaults_map) for item in items]
            )
        except DeclarationMappingError as err:
            set_pending_declarations([])
            return jsonify({"code": 400, "msg": str(err), "data": None}), 400
        return None

    @app.teardown_request
    def clear_posthub_declarations(_error):
        set_pending_declarations([])

    app.extensions[_HOOK_MARKER] = True


def register_posthub_routes(app: Flask, db_path: Path) -> None:
    """注册 PostHub-owned 账号默认声明路由，重复调用无副作用。"""
    if app.extensions.get(_ROUTE_MARKER):
        return

    @app.get("/getAccountDefaults")
    def get_account_defaults():
        out: dict[str, dict] = {}
        try:
            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    "SELECT filePath, default_platform_fields FROM user_info"
                ).fetchall()
        except sqlite3.OperationalError as err:
            if "no such column" in str(err).lower():
                return jsonify(
                    {
                        "code": 500,
                        "msg": "user_info 缺 default_platform_fields 列，请先启动后端一次让 db_init 迁移",
                        "data": None,
                    }
                ), 500
            return jsonify({"code": 500, "msg": str(err), "data": None}), 500

        for file_path, raw in rows:
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if isinstance(parsed, dict):
                out[file_path] = parsed
        return jsonify({"code": 200, "msg": None, "data": out}), 200

    @app.post("/updateAccountDefaults")
    def update_account_defaults():
        payload = request.get_json(silent=True)
        if not payload or "id" not in payload:
            return jsonify({"code": 400, "msg": "缺少账号 id", "data": None}), 400

        fields = payload.get("default_platform_fields")
        if fields is None:
            serialized: str | None = None
        elif isinstance(fields, dict):
            try:
                serialized = json.dumps(fields, ensure_ascii=False)
            except (TypeError, ValueError):
                return jsonify(
                    {
                        "code": 400,
                        "msg": "default_platform_fields 不是合法 JSON 对象",
                        "data": None,
                    }
                ), 400
        else:
            return jsonify(
                {
                    "code": 400,
                    "msg": "default_platform_fields 必须是 object 或 null",
                    "data": None,
                }
            ), 400

        try:
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "UPDATE user_info SET default_platform_fields = ? WHERE id = ?",
                    (serialized, payload.get("id")),
                )
                conn.commit()
            return jsonify({"code": 200, "msg": "ok", "data": None}), 200
        except sqlite3.OperationalError as err:
            if "no such column" in str(err).lower():
                return jsonify(
                    {
                        "code": 500,
                        "msg": "user_info 缺 default_platform_fields 列，请先启动后端一次让 db_init 迁移",
                        "data": None,
                    }
                ), 500
            return jsonify({"code": 500, "msg": str(err), "data": None}), 500
        except sqlite3.Error as err:
            return jsonify({"code": 500, "msg": str(err), "data": None}), 500

    app.extensions[_ROUTE_MARKER] = True
