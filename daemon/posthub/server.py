"""PostHub 守护进程：本地 HTTP IPC + 健康检查。

常驻服务进程，默认监听 `http://127.0.0.1:8756`。前端通过 `GET /health` 检查连通性。
启动方式：`uv run python -m posthub [PORT]`。
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import conf
from posthub import __version__

HOST = "127.0.0.1"
DEFAULT_PORT = 8756

__all__ = ["HOST", "DEFAULT_PORT", "make_server", "main"]


class PostHubHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
                    "BASE_DIR": c.BASE_DIR,
                    "DEBUG_MODE": c.DEBUG_MODE,
                    "LOCAL_CHROME_HEADLESS": c.LOCAL_CHROME_HEADLESS,
                    "LOCAL_CHROME_PATH": c.LOCAL_CHROME_PATH,
                    "XHS_SERVER": c.XHS_SERVER,
                    "YT_PROXY": c.YT_PROXY,
                },
            )
        else:
            self._send_json(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        # 静默访问日志，避免污染 stdout
        return


def make_server(port: int = 0) -> ThreadingHTTPServer:
    """创建守护进程 HTTP 服务。port=0 时由系统分配端口（测试用）。"""
    return ThreadingHTTPServer((HOST, port), PostHubHandler)


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
