"""PostHub 守护进程：本地 HTTP IPC + 健康检查 + 账号管理。

常驻服务进程，默认监听 `http://127.0.0.1:8756`。前端通过 HTTP 调用：

- `GET  /health`           健康检查
- `GET  /conf`             上游 conf 六符号
- `GET  /accounts`         账号列表
- `POST /accounts`         添加账号（落库 + 拉起独立 Chrome 扫码）
- `DELETE /accounts/{id}`  删除账号（移除记录 + 尽力清理关联 Chrome）

启动方式：`uv run python -m posthub [PORT]`。
"""

from __future__ import annotations

import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import conf
from posthub import __version__
from posthub.accounts import (
    AccountConflictError,
    NewAccount,
    SqliteAccountStore,
    default_db_path,
    default_profile_dir,
)
from posthub.chrome_launcher import ChromeLauncher

HOST = "127.0.0.1"
DEFAULT_PORT = 8756
PLATFORMS = ("douyin", "xiaohongshu", "wechat")

__all__ = ["HOST", "DEFAULT_PORT", "make_server", "main"]


def _port_free(port: int) -> bool:
    """试探端口是否空闲（可绑定）。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return False
    except OSError:
        return True


class PostHubHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("body 必须是 JSON 对象")
        return parsed

    # ---- GET ----

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": __version__,
                    "port": self.server.server_address[1],
                },
            )
        elif path == "/conf":
            c = conf.load_conf()
            self._send_json(
                200,
                {
                    "BASE_DIR": str(c.BASE_DIR),
                    "DEBUG_MODE": c.DEBUG_MODE,
                    "LOCAL_CHROME_HEADLESS": c.LOCAL_CHROME_HEADLESS,
                    "LOCAL_CHROME_PATH": c.LOCAL_CHROME_PATH,
                    "XHS_SERVER": c.XHS_SERVER,
                    "YT_PROXY": c.YT_PROXY,
                },
            )
        elif path == "/accounts":
            accounts = [a.to_dict() for a in self.server.account_store.list()]
            self._send_json(200, {"accounts": accounts})
        else:
            self._send_json(404, {"error": "not found"})

    # ---- POST ----

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/accounts":
            self._handle_create_account()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_create_account(self) -> None:
        try:
            body = self._read_json_body()
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "请求体必须是合法 JSON 对象"})
            return

        platform = body.get("platform")
        if platform not in PLATFORMS:
            self._send_json(
                400,
                {"error": f"platform 必须是 douyin/xiaohongshu/wechat，收到 {platform!r}"},
            )
            return

        name = body.get("name") or platform

        cdp_port = body.get("cdp_port")
        if cdp_port is not None:
            if (
                isinstance(cdp_port, bool)
                or not isinstance(cdp_port, int)
                or not (1024 <= cdp_port <= 65535)
            ):
                self._send_json(
                    400,
                    {"error": "cdp_port 必须是 1024~65535 的整数"},
                )
                return
        else:
            try:
                cdp_port = self._allocate_cdp_port()
            except ValueError as exc:
                self._send_json(503, {"error": str(exc)})
                return

        profile_dir = os.path.join(
            self.server.profile_base_dir, f"{platform}-{cdp_port}"
        )
        new = NewAccount(
            platform=platform,
            name=str(name),
            profile_dir=profile_dir,
            cdp_port=cdp_port,
        )
        try:
            account = self.server.account_store.create(new)
        except AccountConflictError as exc:
            self._send_json(409, {"error": str(exc)})
            return

        launch_warning: str | None = None
        try:
            self.server.chrome_launcher.launch(
                platform=account.platform,
                profile_dir=account.profile_dir,
                cdp_port=account.cdp_port,
            )
        except Exception as exc:  # Chrome 未安装等：账号已落库，可稍后重试拉起
            launch_warning = str(exc)

        payload = account.to_dict()
        if launch_warning:
            payload["launch_warning"] = launch_warning
        self._send_json(201, {"account": payload})

    def _allocate_cdp_port(self) -> int:
        used = {a.cdp_port for a in self.server.account_store.list()}
        for port in range(9222, 9222 + 500):
            if port in used:
                continue
            if _port_free(port):
                return port
        raise ValueError("无可用调试端口")

    # ---- DELETE ----

    def do_DELETE(self) -> None:
        path = self.path.split("?", 1)[0]
        prefix = "/accounts/"
        if path.startswith(prefix):
            raw_id = path[len(prefix):]
            if not raw_id.isdigit():
                self._send_json(400, {"error": "账号 id 必须是整数"})
                return
            account = self.server.account_store.get(int(raw_id))
            if account is None:
                self._send_json(404, {"error": "账号不存在"})
                return
            self.server.account_store.delete(account.id)
            try:
                self.server.chrome_launcher.kill_by_profile_dir(account.profile_dir)
            except Exception:
                pass  # 尽力清理，失败不影响删除
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        # 静默访问日志，避免污染 stdout
        return


def make_server(
    port: int = 0,
    *,
    store=None,
    launcher=None,
    profile_base_dir: str | None = None,
) -> ThreadingHTTPServer:
    """创建守护进程 HTTP 服务。port=0 时由系统分配端口（测试用）。

    依赖注入：`store`（账号存储）、`launcher`（Chrome 拉起器）供测试替换；
    缺省时使用 SQLite 持久化 + 真实 Chrome 拉起器。
    """
    httpd = ThreadingHTTPServer((HOST, port), PostHubHandler)
    httpd.account_store = store or SqliteAccountStore(default_db_path())
    httpd.chrome_launcher = launcher or ChromeLauncher()
    httpd.profile_base_dir = profile_base_dir or default_profile_dir()
    return httpd


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(argv[0]) if argv else DEFAULT_PORT
    httpd = make_server(port)
    actual_port = httpd.server_address[1]
    print(f"[posthub-daemon] listening on http://{HOST}:{actual_port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
