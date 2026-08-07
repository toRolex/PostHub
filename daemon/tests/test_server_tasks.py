"""守护进程任务 / 约束 IPC 测试：GET /platform-constraints + POST /tasks。

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
from posthub.tasks import InMemoryTaskStore, NewTaskSpec, PlatformJobSpec


def make_accounts(store) -> None:
    store.create(
        NewAccount(
            platform="douyin",
            name="抖音一号",
            profile_dir="/tmp/p-douyin",
            cdp_port=9222,
        )
    )
    store.create(
        NewAccount(
            platform="xiaohongshu",
            name="小红书",
            profile_dir="/tmp/p-xhs",
            cdp_port=9223,
        )
    )
    store.create(
        NewAccount(
            platform="wechat",
            name="视频号",
            profile_dir="/tmp/p-wechat",
            cdp_port=9224,
        )
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


def post(url: str, path: str, payload: dict) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8")
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


def test_get_platform_constraints_exposes_registry(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/platform-constraints")
    assert status == 200
    by_platform = {c["platform"]: c for c in body["constraints"]}
    assert set(by_platform) == {"douyin", "xiaohongshu", "wechat"}

    assert by_platform["douyin"]["min_lead_time_seconds"] == 2 * 3600
    assert by_platform["douyin"]["cover_required"] is True
    assert by_platform["xiaohongshu"]["min_lead_time_seconds"] == 3600
    assert by_platform["xiaohongshu"]["auto_cover_first_frame"] is True
    assert by_platform["wechat"]["max_scheduled_per_day"] == 5
    assert by_platform["wechat"]["schedule_max_seconds"] == 30 * 24 * 3600


def test_create_task_immediate(server_ctx) -> None:
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "春日踏青",
            "video_path": "/tmp/video.mp4",
            "caption": "一起出发",
            "jobs": [{"platform": "douyin", "account_id": 1}],
        },
    )
    assert status == 201
    task = body["task"]
    assert task["title"] == "春日踏青"
    assert task["status"] == "pending"
    assert task["schedule_policy"] == "immediate"

    jobs = body["jobs"]
    assert len(jobs) == 1
    assert jobs[0]["platform"] == "douyin"
    assert jobs[0]["account_id"] == 1
    assert jobs[0]["status"] == "pending"
    assert jobs[0]["schedule_policy"] is None  # 继承 task
    assert jobs[0]["publish_at"] is None


def test_create_task_scheduled_multi_platform(server_ctx) -> None:
    publish_at = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "定时发布",
            "video_path": "/tmp/video.mp4",
            "schedule_policy": "scheduled",
            "publish_mode": "platform_time",
            "publish_at": publish_at,
            "jobs": [
                {"platform": "douyin", "account_id": 1},
                {"platform": "xiaohongshu", "account_id": 2},
                {"platform": "wechat", "account_id": 3},
            ],
        },
    )
    assert status == 201
    assert body["task"]["schedule_policy"] == "scheduled"
    assert body["task"]["publish_at"] == publish_at
    assert len(body["jobs"]) == 3
    assert {j["platform"] for j in body["jobs"]} == {
        "douyin",
        "xiaohongshu",
        "wechat",
    }


def test_create_task_account_platform_mismatch_returns_400(server_ctx) -> None:
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "x",
            "video_path": "/tmp/v.mp4",
            "jobs": [{"platform": "douyin", "account_id": 2}],  # 2 是小红书账号
        },
    )
    assert status == 400
    assert "平台" in body["error"]
    assert server_ctx["task_store"].get_task(1) is None


def test_create_task_unknown_account_returns_400(server_ctx) -> None:
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "x",
            "video_path": "/tmp/v.mp4",
            "jobs": [{"platform": "douyin", "account_id": 999}],
        },
    )
    assert status == 400
    assert "账号" in body["error"]


def test_create_task_empty_title_returns_400(server_ctx) -> None:
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": " ",
            "video_path": "/tmp/v.mp4",
            "jobs": [{"platform": "douyin", "account_id": 1}],
        },
    )
    assert status == 400
    assert "标题" in body["error"]


def test_create_task_scheduled_too_soon_returns_400(server_ctx) -> None:
    too_soon = (datetime.now() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
    status, body = post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "x",
            "video_path": "/tmp/v.mp4",
            "schedule_policy": "scheduled",
            "publish_at": too_soon,
            "jobs": [{"platform": "douyin", "account_id": 1}],
        },
    )
    assert status == 400
    assert "定时" in body["error"]


def test_create_task_invalid_json_returns_400(server_ctx) -> None:
    req = urllib.request.Request(
        server_ctx["url"] + "/tasks",
        data=b"not-json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(req, timeout=5)
    assert excinfo.value.code == 400


# ---- issue #21：任务状态可查（manual / needs_relogin 呈现的前提）+ 手动重试 ----

def test_get_tasks_lists_tasks_with_jobs(server_ctx) -> None:
    post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "A",
            "video_path": "/tmp/a.mp4",
            "jobs": [{"platform": "douyin", "account_id": 1}],
        },
    )
    post(
        server_ctx["url"],
        "/tasks",
        {
            "title": "B",
            "video_path": "/tmp/b.mp4",
            "jobs": [
                {"platform": "xiaohongshu", "account_id": 2},
                {"platform": "wechat", "account_id": 3},
            ],
        },
    )

    status, body = get(server_ctx["url"], "/tasks")
    assert status == 200
    tasks = body["tasks"]
    assert len(tasks) == 2
    by_title = {t["task"]["title"]: t for t in tasks}
    assert by_title["A"]["task"]["status"] == "pending"
    assert len(by_title["A"]["jobs"]) == 1
    assert by_title["A"]["jobs"][0]["platform"] == "douyin"
    assert by_title["B"]["task"]["status"] == "pending"
    assert len(by_title["B"]["jobs"]) == 2


def test_get_tasks_empty(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/tasks")
    assert status == 200
    assert body["tasks"] == []


def test_retry_job_resets_terminal_to_pending(server_ctx) -> None:
    task_store = server_ctx["task_store"]
    task, jobs = task_store.create_task(
        NewTaskSpec(
            title="验证码挂起",
            video_path="/tmp/v.mp4",
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    # 调度层产生终态 manual（验证码）
    task_store.apply_terminal(jobs[0].id, "2026-08-08 00:00:00", "manual", "验证码", "risk_control")
    assert task_store.list_jobs(task.id)[0].status == "manual"

    status, body = post(
        server_ctx["url"],
        f"/tasks/{task.id}/jobs/{jobs[0].id}/retry",
        {},
    )
    assert status == 200
    assert body["ok"] is True
    assert task_store.list_jobs(task.id)[0].status == "pending"


def test_retry_job_only_terminal_states(server_ctx) -> None:
    task_store = server_ctx["task_store"]
    task, jobs = task_store.create_task(
        NewTaskSpec(
            title="进行中不可重试",
            video_path="/tmp/v.mp4",
            jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
        )
    )
    status, body = post(
        server_ctx["url"],
        f"/tasks/{task.id}/jobs/{jobs[0].id}/retry",
        {},
    )
    assert status == 400
    assert "可手动重试" in body["error"]


def test_retry_missing_job_returns_404(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/tasks/1/jobs/999/retry", {})
    assert status == 404
    assert "不存在" in body["error"]
