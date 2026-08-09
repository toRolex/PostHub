"""守护进程 HTTP 本地 IPC 测试：健康检查接口连通性。"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import pytest

from posthub.accounts import InMemoryAccountStore
from posthub.server import make_server


@pytest.fixture()
def server_url():
    httpd = make_server(port=0, store=InMemoryAccountStore())
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    httpd.server_close()


def get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def test_health_ok(server_url) -> None:
    status, body = get(f"{server_url}/health")
    assert status == 200
    assert body["status"] == "ok"
    assert body["version"]


def test_conf_endpoint_exposes_six_symbols(server_url) -> None:
    status, body = get(f"{server_url}/conf")
    assert status == 200
    for name in (
        "BASE_DIR",
        "DEBUG_MODE",
        "LOCAL_CHROME_HEADLESS",
        "LOCAL_CHROME_PATH",
        "XHS_SERVER",
        "YT_PROXY",
    ):
        assert name in body


def test_unknown_route_returns_404(server_url) -> None:
    status, body = get(f"{server_url}/nope")
    assert status == 404
    assert body["error"] == "not found"


def test_make_server_wires_scheduler() -> None:
    # P0 接线：make_server 创建 scheduler，供 main() 后台 tick 驱动任务自动执行
    httpd = make_server(port=0, store=InMemoryAccountStore())
    try:
        assert hasattr(httpd, "scheduler")
        # 调度器与 httpd 共享同一 task_store / account_store / 事件 hub
        assert httpd.scheduler.task_store is httpd.task_store
        assert httpd.scheduler.account_store is httpd.account_store
        assert httpd.scheduler.notifier is httpd.interventions
    finally:
        httpd.server_close()
