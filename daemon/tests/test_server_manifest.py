"""守护进程批量导入 IPC 测试：POST /batches/import + POST /batches/confirm。

注入 InMemoryAccountStore + InMemoryTaskStore，验证 HTTP 契约与落库结果。
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount
from posthub.server import make_server
from posthub.tasks import InMemoryTaskStore

TIME_FMT = "%Y-%m-%d %H:%M:%S"


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


def post(url: str, path: str, payload: dict) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def make_batch(tmp_path, manifest: dict, files: list[str] | None = None) -> Path:
    folder = tmp_path / "batch"
    folder.mkdir(exist_ok=True)
    for name in files or ["视频1.mp4", "视频2.mp4", "cover1.jpg"]:
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(b"x")
    (folder / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return folder


def valid_manifest() -> dict:
    return {
        "version": 1,
        "videos": [
            {
                "file": "视频1.mp4",
                "title": "标题1",
                "schedule": (datetime.now() + timedelta(days=3)).strftime(TIME_FMT),
            },
            {"file": "视频2.mp4", "title": "标题2"},
        ],
    }


def test_batch_import_returns_parsed_entries(server_ctx, tmp_path) -> None:
    folder = make_batch(tmp_path, valid_manifest())
    status, body = post(
        server_ctx["url"],
        "/batches/import",
        {"folder_path": str(folder), "account_id": 1},
    )
    assert status == 200
    assert body["version"] == 1
    assert body["hard_errors"] == []
    assert len(body["entries"]) == 2
    assert body["entries"][0]["title"] == "标题1"
    assert body["entries"][0]["file"] == str((folder / "视频1.mp4").resolve())


def test_batch_import_hard_errors_returned(server_ctx, tmp_path) -> None:
    folder = tmp_path / "bad"
    folder.mkdir()
    (folder / "manifest.json").write_text(
        json.dumps({"version": 1, "videos": [{"title": "无file"}]}),
        encoding="utf-8",
    )
    status, body = post(
        server_ctx["url"],
        "/batches/import",
        {"folder_path": str(folder), "account_id": 1},
    )
    assert status == 200
    assert len(body["hard_errors"]) == 1
    assert body["hard_errors"][0]["index"] == 0
    assert "file" in body["hard_errors"][0]["message"]
    assert body["entries"] == []


def test_batch_import_unknown_account_returns_404(server_ctx) -> None:
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post(
            server_ctx["url"],
            "/batches/import",
            {"folder_path": "/tmp/x", "account_id": 999},
        )
    assert excinfo.value.code == 404
    assert "账号不存在" in json.loads(excinfo.value.read().decode("utf-8"))["error"]


def test_batch_import_missing_folder_path_returns_400(server_ctx) -> None:
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post(server_ctx["url"], "/batches/import", {"account_id": 1})
    assert excinfo.value.code == 400


def test_batch_confirm_creates_tasks(server_ctx) -> None:
    status, body = post(
        server_ctx["url"],
        "/batches/confirm",
        {
            "account_id": 1,
            "entries": [
                {
                    "file": "/tmp/v1.mp4",
                    "title": "批量1",
                    "content": "正文1",
                    "account_id": 1,
                    "platform": "douyin",
                },
                {"file": "/tmp/v2.mp4", "title": "批量2", "account_id": 1, "platform": "douyin"},
            ],
        },
    )
    assert status == 201
    assert body["task_ids"] == [1, 2]
    assert len(body["tasks"]) == 2

    t1 = server_ctx["task_store"].get_task(1)
    assert t1.title == "批量1"
    assert t1.caption == "正文1"
    jobs1 = server_ctx["task_store"].list_jobs(1)
    assert jobs1[0].account_id == 1
    assert jobs1[0].platform == "douyin"


def test_batch_confirm_invalid_entry_returns_400(server_ctx) -> None:
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        post(
            server_ctx["url"],
            "/batches/confirm",
            {
                "account_id": 1,
                "entries": [
                    {"file": "/tmp/v1.mp4", "title": "批量1", "account_id": 999, "platform": "douyin"}
                ],
            },
        )
    assert excinfo.value.code == 400
    # 原子性：任一条目非法，整批不落库
    assert server_ctx["task_store"].get_task(1) is None
