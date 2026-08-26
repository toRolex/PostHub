"""PostHub-owned Flask 扩展路由与官方发布 seam 适配。

本模块只在组合入口中注册：官方 ``sau_backend.py`` 保持上游副本，PostHub
扩展通过 Flask 生命周期钩子和独立路由接入，不把自研能力继续堆进官方模块。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from flask import Flask, g, jsonify, request

from posthub.publish_adapter import NormalizationError, normalize_publish_payloads
from posthub.uploader_wrapper import (
    set_pending_declarations,
    set_pending_effective_items,
)

_ROUTE_MARKER = "_posthub_owned_routes_registered"
_HOOK_MARKER = "_posthub_declaration_hooks_registered"


def _read_account_defaults_rows(db_path: Path) -> list[tuple[str, str | None]]:
    """读取官方账号默认声明原始行；JSON 解析统一由下方 reader 完成。"""
    with sqlite3.connect(db_path) as conn:
        return conn.execute(
            "SELECT filePath, default_platform_fields FROM user_info"
        ).fetchall()


def _parse_account_defaults_rows(rows: list[tuple[str, str | None]]) -> dict[str, dict]:
    out: dict[str, dict] = {}
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


def _read_publish_account_rows(db_path: Path) -> list[dict[str, Any]]:
    """读取 normalization 所需的官方账号快照输入。"""
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, type, filePath, userName, status, default_platform_fields
            FROM user_info
            """
        ).fetchall()
    return [
        {
            "id": row[0],
            "type": row[1],
            "filePath": row[2],
            "userName": row[3],
            "status": row[4],
            "default_platform_fields": row[5],
        }
        for row in rows
    ]


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
            normalized = normalize_publish_payloads(
                items, _read_publish_account_rows(db_path)
            )
            g.posthub_normalized_batch = normalized
            set_pending_effective_items(normalized.effective)
        except (NormalizationError, sqlite3.Error) as err:
            set_pending_effective_items([])
            set_pending_declarations([])
            return jsonify({"code": 400, "msg": str(err), "data": None}), 400
        return None

    @app.teardown_request
    def clear_posthub_declarations(_error):
        set_pending_effective_items([])
        set_pending_declarations([])

    app.extensions[_HOOK_MARKER] = True


def register_posthub_routes(app: Flask, db_path: Path) -> None:
    """注册 PostHub-owned 账号默认声明路由，重复调用无副作用。"""
    if app.extensions.get(_ROUTE_MARKER):
        return

    @app.get("/getAccountDefaults")
    def get_account_defaults():
        try:
            out = _parse_account_defaults_rows(_read_account_defaults_rows(db_path))
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
