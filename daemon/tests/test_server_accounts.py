"""守护进程账号 IPC 测试：GET/POST/DELETE /accounts + 拉起 Chrome。

注入 InMemoryAccountStore + FakeLauncher，验证 HTTP 行为与依赖调用，不落真实 Chrome。
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import pytest

from posthub.accounts import InMemoryAccountStore, SqliteAccountStore
from posthub.chrome_launcher import ChromeNotFoundError
from posthub.server import make_server


class FakeLauncher:
    """fake Chrome 拉起器：记录调用、可配置抛错。"""

    def __init__(self) -> None:
        self.launch_calls: list[dict] = []
        self.kill_calls: list[str] = []
        self.launch_raises: Exception | None = None

    def launch(self, *, platform, profile_dir, cdp_port, chrome_path=None):
        if self.launch_raises is not None:
            raise self.launch_raises
        self.launch_calls.append(
            {
                "platform": platform,
                "profile_dir": profile_dir,
                "cdp_port": cdp_port,
                "chrome_path": chrome_path,
            }
        )
        return object()

    def kill_by_profile_dir(self, profile_dir: str) -> None:
        self.kill_calls.append(profile_dir)

    def wait_for_cdp(self, port: int, timeout: float = 10.0) -> bool:
        return True


@pytest.fixture()
def server_ctx(tmp_path):
    store = InMemoryAccountStore()
    launcher = FakeLauncher()
    httpd = make_server(
        port=0,
        store=store,
        launcher=launcher,
        profile_base_dir=str(tmp_path / "profiles"),
    )
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    yield {"url": url, "store": store, "launcher": launcher}
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


def delete(url: str, path: str) -> tuple[int, dict]:
    req = urllib.request.Request(url + path, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def test_list_accounts_empty(server_ctx) -> None:
    status, body = get(server_ctx["url"], "/accounts")
    assert status == 200
    assert body["accounts"] == []


def test_create_account_launches_chrome(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "抖音一号"})
    assert status == 201

    account = body["account"]
    assert account["platform"] == "douyin"
    assert account["name"] == "抖音一号"
    assert account["status"] == "active"
    assert account["cdp_port"] >= 9222

    launcher = server_ctx["launcher"]
    assert len(launcher.launch_calls) == 1
    call = launcher.launch_calls[0]
    assert call["platform"] == "douyin"
    assert call["profile_dir"] == account["profile_dir"]
    assert call["cdp_port"] == account["cdp_port"]
    assert call["profile_dir"].endswith(f"douyin-{account['cdp_port']}")


def test_create_account_with_explicit_port(server_ctx) -> None:
    status, body = post(
        server_ctx["url"], "/accounts", {"platform": "wechat", "name": "视频号", "cdp_port": 9333}
    )
    assert status == 201
    assert body["account"]["cdp_port"] == 9333
    assert body["account"]["profile_dir"].endswith("wechat-9333")


def test_create_account_defaults_name_to_platform(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "xiaohongshu"})
    assert status == 201
    assert body["account"]["name"] == "xiaohongshu"


def test_list_accounts_after_create(server_ctx) -> None:
    post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    post(server_ctx["url"], "/accounts", {"platform": "wechat", "name": "b"})

    status, body = get(server_ctx["url"], "/accounts")
    assert status == 200
    assert len(body["accounts"]) == 2
    assert {a["platform"] for a in body["accounts"]} == {"douyin", "wechat"}


def test_create_invalid_platform_returns_400(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "kuaishou", "name": "x"})
    assert status == 400
    assert "platform" in body["error"]


def test_create_duplicate_platform_port_returns_409(server_ctx) -> None:
    post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a", "cdp_port": 9222})
    status, body = post(
        server_ctx["url"], "/accounts", {"platform": "douyin", "name": "b", "cdp_port": 9222}
    )
    assert status == 409
    assert "已存在" in body["error"]


def test_create_invalid_json_returns_400(server_ctx) -> None:
    req = urllib.request.Request(
        server_ctx["url"] + "/accounts",
        data=b"not-json",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(req, timeout=5)
    assert excinfo.value.code == 400


def test_create_launch_warning_when_chrome_missing(server_ctx) -> None:
    server_ctx["launcher"].launch_raises = ChromeNotFoundError("未找到 Chrome/Edge")
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    assert status == 201
    assert "launch_warning" in body["account"]
    # 账号仍已落库（可稍后重试拉起）
    assert len(server_ctx["store"].list()) == 1


def test_delete_account_removes_record_and_kills_chrome(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    account_id = body["account"]["id"]
    profile_dir = body["account"]["profile_dir"]

    dstatus, dbody = delete(server_ctx["url"], f"/accounts/{account_id}")
    assert dstatus == 200
    assert dbody["ok"] is True
    assert server_ctx["store"].get(account_id) is None
    assert server_ctx["launcher"].kill_calls == [profile_dir]


def test_delete_missing_account_returns_404(server_ctx) -> None:
    status, body = delete(server_ctx["url"], "/accounts/9999")
    assert status == 404


def test_delete_invalid_id_returns_400(server_ctx) -> None:
    status, body = delete(server_ctx["url"], "/accounts/not-a-number")
    assert status == 400


def test_sqlite_store_works_through_threaded_server(tmp_path) -> None:
    """回归：ThreadingHTTPServer 每请求在独立线程，SQLite 连接须可跨线程复用。"""
    store = SqliteAccountStore(tmp_path / "accounts.db")
    launcher = FakeLauncher()
    httpd = make_server(
        port=0,
        store=store,
        launcher=launcher,
        profile_base_dir=str(tmp_path / "profiles"),
    )
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    try:
        status, body = post(url, "/accounts", {"platform": "douyin", "name": "a"})
        assert status == 201

        status, body = get(url, "/accounts")
        assert status == 200
        assert len(body["accounts"]) == 1
        assert body["accounts"][0]["name"] == "a"

        dstatus, _ = delete(url, "/accounts/1")
        assert dstatus == 200
        assert store.list() == []
    finally:
        httpd.shutdown()
        httpd.server_close()
        store.close()


# ---- issue #21：重登引导（relogin）+ 账号状态恢复 ----

def test_relogin_launches_chrome_for_account(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    account_id = body["account"]["id"]
    profile_dir = body["account"]["profile_dir"]

    server_ctx["launcher"].launch_calls.clear()
    rstatus, rbody = post(server_ctx["url"], f"/accounts/{account_id}/relogin", {})
    assert rstatus == 200
    assert rbody["ok"] is True

    launcher = server_ctx["launcher"]
    assert len(launcher.launch_calls) == 1
    call = launcher.launch_calls[0]
    assert call["platform"] == "douyin"
    assert call["profile_dir"] == profile_dir
    assert call["cdp_port"] == body["account"]["cdp_port"]


def test_relogin_missing_account_returns_404(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts/999/relogin", {})
    assert status == 404
    assert "账号" in body["error"]


def test_relogin_invalid_id_returns_400(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts/not-a-number/relogin", {})
    assert status == 400
    assert "整数" in body["error"]


def test_relogin_chrome_missing_returns_warning(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    account_id = body["account"]["id"]
    server_ctx["launcher"].launch_raises = ChromeNotFoundError("未找到 Chrome/Edge")

    rstatus, rbody = post(server_ctx["url"], f"/accounts/{account_id}/relogin", {})
    assert rstatus == 200
    assert rbody["ok"] is True
    assert "launch_warning" in rbody


def test_set_account_status_active(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    account_id = body["account"]["id"]
    server_ctx["store"].set_status(account_id, "needs_relogin")

    sstatus, sbody = post(
        server_ctx["url"],
        f"/accounts/{account_id}/status",
        {"status": "active"},
    )
    assert sstatus == 200
    assert sbody["ok"] is True
    assert server_ctx["store"].get(account_id).status == "active"


def test_set_account_status_invalid_status_returns_400(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts", {"platform": "douyin", "name": "a"})
    account_id = body["account"]["id"]

    sstatus, sbody = post(
        server_ctx["url"],
        f"/accounts/{account_id}/status",
        {"status": "bogus"},
    )
    assert sstatus == 400
    assert "status" in sbody["error"]


def test_set_account_status_missing_account_returns_404(server_ctx) -> None:
    status, body = post(server_ctx["url"], "/accounts/999/status", {"status": "active"})
    assert status == 404
    assert "账号" in body["error"]
