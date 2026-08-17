"""官方后端 seam 契约 smoke：启动 → 探活 → /getAccounts → 停后端。

就绪探针策略（不依赖 /health 是否存在于官方后端）：
1. TCP connect 127.0.0.1:5409 成功；
2. GET /getAccounts 返回 HTTP 200。
两项都满足才算就绪；轮询间隔 0.5s，超时 20s。
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Iterator

import pytest

DAEMON_DIR = Path(__file__).resolve().parent.parent
BACKEND_URL = "http://127.0.0.1:5409"
PORT = 5409


def _tcp_ready(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _get_accounts_ok() -> bool:
    try:
        with urllib.request.urlopen(f"{BACKEND_URL}/getAccounts", timeout=2) as resp:
            return resp.status == 200
    except OSError:
        return False


def _wait_ready(timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _tcp_ready("127.0.0.1", PORT) and _get_accounts_ok():
            return True
        time.sleep(0.5)
    return False


@pytest.fixture(scope="module")
def backend() -> Iterator[str]:
    """启动官方后端（经 venv python 运行 run_backend.py），返回 base url；拆除时停进程。"""
    proc = subprocess.Popen(
        [sys.executable, str(DAEMON_DIR / "run_backend.py")],
        cwd=DAEMON_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        assert _wait_ready(), "官方后端未在 20s 内就绪（TCP 5409 + /getAccounts 200）"
        yield BACKEND_URL
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_backend_reachable(backend: str) -> None:
    """后端已监听 127.0.0.1:5409（fixture 就绪探针已保证）。"""
    assert backend == BACKEND_URL
    assert _tcp_ready("127.0.0.1", PORT)


def test_get_accounts_returns_200_with_code_field(backend: str) -> None:
    """契约 smoke：/getAccounts 返回官方格式 JSON（含 code 字段），无需登录。"""
    with urllib.request.urlopen(f"{backend}/getAccounts", timeout=5) as resp:
        assert resp.status == 200
        body = json.loads(resp.read())
    assert "code" in body, "官方响应 JSON 必须含 code 字段"
    assert body["code"] == 200