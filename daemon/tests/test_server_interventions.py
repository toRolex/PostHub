"""守护进程人工介入事件 IPC 测试（issue #21）。

- `GET /interventions`：返回 hub 中未处理（pending）的人工介入事件。
- `POST /interventions/{id}/ack`：标记已处理，随后不再出现在 pending。
- `make_server` 可注入 `interventions` hub（测试用 InMemory）。
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import pytest

from posthub.accounts import InMemoryAccountStore
from posthub.interventions import InMemoryInterventionHub, NewIntervention
from posthub.server import make_server
from posthub.tasks import InMemoryTaskStore


@pytest.fixture()
def server_ctx(tmp_path):
    accounts = InMemoryAccountStore()
    task_store = InMemoryTaskStore(accounts)
    hub = InMemoryInterventionHub()
    httpd = make_server(
        port=0,
        store=accounts,
        task_store=task_store,
        interventions=hub,
        profile_base_dir=str(tmp_path / "profiles"),
    )
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    yield {"url": url, "hub": hub}
    httpd.shutdown()
    httpd.server_close()


def get(url: str, path: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url + path, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def post(url: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def test_get_interventions_empty(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/interventions")
    assert status == 200
    assert body["interventions"] == []


def test_get_interventions_returns_pending(server_ctx) -> None:
    hub = server_ctx["hub"]
    hub.notify(
        NewIntervention(
            kind="manual",
            job_id=1,
            task_id=1,
            account_id=1,
            platform="douyin",
            message="验证码",
            error_type="risk_control",
            created_at="2026-08-08 00:00:00",
        )
    )
    hub.notify(
        NewIntervention(
            kind="needs_relogin",
            job_id=2,
            task_id=1,
            account_id=1,
            platform="douyin",
            message="登录失效",
            error_type="auth",
            created_at="2026-08-08 00:00:00",
        )
    )

    status, body = get(server_ctx["url"], "/interventions")
    assert status == 200
    interventions = body["interventions"]
    assert len(interventions) == 2
    assert {i["kind"] for i in interventions} == {"manual", "needs_relogin"}
    assert interventions[0]["job_id"] == 1
    assert interventions[0]["error_type"] == "risk_control"


def test_ack_intervention_removes_from_pending(server_ctx) -> None:
    hub = server_ctx["hub"]
    iv = hub.notify(
        NewIntervention(
            kind="manual",
            job_id=1,
            task_id=1,
            account_id=1,
            platform="douyin",
        )
    )

    status, body = post(server_ctx["url"], f"/interventions/{iv.id}/ack")
    assert status == 200
    assert body["ok"] is True
    assert hub.pending() == []


def test_ack_missing_intervention_returns_404(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/interventions/999/ack")
    assert status == 404
    assert "不存在" in body["error"]


def test_ack_invalid_id_returns_400(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/interventions/not-a-number/ack")
    assert status == 400
    assert "整数" in body["error"]
