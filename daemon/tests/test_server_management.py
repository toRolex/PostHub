"""守护进程任务管理 IPC 测试（#18）。

- `GET  /tasks?platform=&status=&from=&to=`   任务列表（含 job 明细）筛选
- `GET  /tasks/{id}`                          单任务明细
- `POST /tasks/{id}/cancel`                   取消尚未发布的任务
- `POST /jobs/{id}/retry`                     失败任务重试
- `GET  /logs?level=&task_id=`                应用内日志查询

注入 InMemoryAccountStore + InMemoryTaskStore，验证 HTTP 行为与落库结果。
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount
from posthub.server import make_server
from posthub.tasks import InMemoryTaskStore

T0 = "2026-08-08 00:00:00"


def make_accounts(store) -> None:
    store.create(
        NewAccount(platform="douyin", name="抖音一号", profile_dir="/tmp/p-douyin", cdp_port=9222)
    )
    store.create(
        NewAccount(platform="xiaohongshu", name="小红书", profile_dir="/tmp/p-xhs", cdp_port=9223)
    )
    store.create(
        NewAccount(platform="wechat", name="视频号", profile_dir="/tmp/p-wechat", cdp_port=9224)
    )


@pytest.fixture()
def server_ctx(tmp_path):
    accounts = InMemoryAccountStore()
    make_accounts(accounts)
    task_store = InMemoryTaskStore(accounts)
    httpd = make_server(
        port=0,
        store=accounts,
        task_store=task_store,
        profile_base_dir=str(tmp_path / "profiles"),
    )
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    yield {"url": url, "accounts": accounts, "task_store": task_store}
    httpd.shutdown()
    httpd.server_close()


def get(url: str, path: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url + path, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def post(url: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else b""
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


def create_task(url: str, title: str, platform: str, account_id: int) -> tuple[int, dict]:
    return post(
        url,
        "/tasks",
        {
            "title": title,
            "video_path": "/tmp/v.mp4",
            "jobs": [{"platform": platform, "account_id": account_id}],
        },
    )


def test_get_tasks_empty(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/tasks")
    assert status == 200
    assert body["tasks"] == []


def test_get_tasks_returns_details_with_jobs(server_ctx) -> None:
    status, body = create_task(server_ctx["url"], "春日踏青", "douyin", 1)
    assert status == 201
    task_id = body["task"]["id"]

    status, body = get(server_ctx["url"], "/tasks")
    assert status == 200
    assert len(body["tasks"]) == 1
    item = body["tasks"][0]
    assert item["task"]["id"] == task_id
    assert item["task"]["status"] == "pending"
    assert len(item["jobs"]) == 1
    assert item["jobs"][0]["platform"] == "douyin"
    assert item["jobs"][0]["status"] == "pending"


def test_get_tasks_filter_by_platform_and_status(server_ctx) -> None:
    create_task(server_ctx["url"], "A", "douyin", 1)
    create_task(server_ctx["url"], "B", "xiaohongshu", 2)
    # 把 B 置为 failed（走存储层模拟调度器终态）
    task_store = server_ctx["task_store"]
    detail = task_store.get_task_detail(2)
    task_store.apply_terminal(detail.jobs[0].id, T0, "failed", "拒", "platform_reject")

    status, body = get(server_ctx["url"], "/tasks?platform=douyin")
    assert status == 200
    assert [t["task"]["title"] for t in body["tasks"]] == ["A"]
    assert all(j["platform"] == "douyin" for t in body["tasks"] for j in t["jobs"])

    status, body = get(server_ctx["url"], "/tasks?status=failed")
    assert status == 200
    assert [t["task"]["title"] for t in body["tasks"]] == ["B"]

    status, body = get(server_ctx["url"], "/tasks?platform=wechat")
    assert status == 200
    assert body["tasks"] == []


def test_get_tasks_invalid_platform_returns_400(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/tasks?platform=bad")
    assert status == 400
    assert "platform" in body["error"]


def test_get_task_detail(server_ctx) -> None:
    _, created = create_task(server_ctx["url"], "A", "douyin", 1)
    task_id = created["task"]["id"]
    status, body = get(server_ctx["url"], f"/tasks/{task_id}")
    assert status == 200
    assert body["task"]["id"] == task_id
    assert len(body["jobs"]) == 1
    assert body["jobs"][0]["task_id"] == task_id


def test_get_task_detail_not_found(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/tasks/999")
    assert status == 404
    assert "任务" in body["error"]


def test_cancel_task_endpoint(server_ctx) -> None:
    _, created = create_task(server_ctx["url"], "A", "douyin", 1)
    task_id = created["task"]["id"]
    status, body = post(server_ctx["url"], f"/tasks/{task_id}/cancel")
    assert status == 200
    assert body["ok"] is True
    assert len(body["canceled"]) == 1
    assert body["canceled"][0]["status"] == "failed"
    assert body["canceled"][0]["last_error"] == "任务已取消"

    # 再次取消：无 pending job → 返回空列表（幂等）
    status, body = post(server_ctx["url"], f"/tasks/{task_id}/cancel")
    assert status == 200
    assert body["canceled"] == []


def test_cancel_task_not_found(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/tasks/999/cancel")
    assert status == 404
    assert "任务" in body["error"]


def test_retry_job_endpoint(server_ctx) -> None:
    _, created = create_task(server_ctx["url"], "A", "douyin", 1)
    task_id = created["task"]["id"]
    job_id = created["jobs"][0]["id"]
    task_store = server_ctx["task_store"]
    task_store.claim_eligible_jobs(T0, limit=3, scheduler_id="s1")
    task_store.apply_terminal(job_id, T0, "failed", "风控", "risk_control")

    status, body = post(server_ctx["url"], f"/jobs/{job_id}/retry")
    assert status == 200
    assert body["ok"] is True
    assert body["job"]["status"] == "pending"

    # 日志页可查重试记录
    status, logs = get(server_ctx["url"], f"/logs?task_id={task_id}")
    assert status == 200
    assert any("重试" in l["message"] for l in logs["logs"])


def test_retry_job_not_retryable_returns_409(server_ctx) -> None:
    _, created = create_task(server_ctx["url"], "A", "douyin", 1)
    job_id = created["jobs"][0]["id"]  # pending，不可重试
    status, body = post(server_ctx["url"], f"/jobs/{job_id}/retry")
    assert status == 409
    assert "重试" in body["error"]


def test_retry_job_not_found(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/jobs/999/retry")
    assert status == 404
    assert "job" in body["error"]


def test_get_logs_with_filters(server_ctx) -> None:
    _, created = create_task(server_ctx["url"], "A", "douyin", 1)
    task_id = created["task"]["id"]
    post(server_ctx["url"], f"/tasks/{task_id}/cancel")

    status, body = get(server_ctx["url"], "/logs")
    assert status == 200
    assert len(body["logs"]) >= 1

    status, body = get(server_ctx["url"], f"/logs?task_id={task_id}")
    assert status == 200
    assert all(l["task_id"] == task_id for l in body["logs"])

    status, body = get(server_ctx["url"], "/logs?level=info")
    assert status == 200
    assert all(l["level"] == "info" for l in body["logs"])

    status, body = get(server_ctx["url"], "/logs?level=debug")
    assert status == 200
    assert body["logs"] == []
