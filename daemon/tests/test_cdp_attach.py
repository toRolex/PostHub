"""CDP 接管 wrapper 测试（issue #20）。

用「假 browser/context 对象」断言 patch 生效（launch 被替换为 connect_over_cdp、
close 被中和不真正关闭、context 复用）。真实 Chrome 连接与真实 upload 属 #11 验收门。
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from posthub.cdp_attach import (
    cdp_attach,
    patch_playwright_for_cdp,
    resolve_local_cdp_endpoint,
)


def run(coro):
    return asyncio.run(coro)


class FakeContext:
    def __init__(self, name: str = "ctx") -> None:
        self.name = name
        self.closed = False
        self.close_calls = 0
        self.storage_state_calls: list = []

    async def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    async def storage_state(self, *args, **kwargs):
        self.storage_state_calls.append((args, kwargs))
        return {}


class FakeBrowser:
    def __init__(self, contexts: list | None = None) -> None:
        self.contexts = contexts if contexts is not None else [FakeContext()]
        self.new_context_calls: list = []
        self.close_calls = 0
        self.closed = False

    async def new_context(self, *args, **kwargs):
        self.new_context_calls.append((args, kwargs))
        ctx = FakeContext(name="new")
        self.contexts.append(ctx)
        return ctx

    async def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class FakeChromium:
    def __init__(self, browser: FakeBrowser) -> None:
        self._browser = browser
        self.launch_calls: list = []
        self.connect_calls: list = []

    async def launch(self, *args, **kwargs):
        self.launch_calls.append((args, kwargs))
        return self._browser

    async def connect_over_cdp(self, cdp_url, **kwargs):
        self.connect_calls.append((cdp_url, kwargs))
        return self._browser


class FakePlaywright:
    def __init__(self, browser: FakeBrowser) -> None:
        self.chromium = FakeChromium(browser)
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


class FakePlaywrightContext:
    """模拟 patchright.async_api.async_playwright() 的返回值（有 .start()）。"""

    def __init__(self, pw: FakePlaywright) -> None:
        self._pw = pw

    async def start(self) -> FakePlaywright:
        return self._pw


def make_pw_with_browser():
    browser = FakeBrowser()
    pw = FakePlaywright(browser)
    return pw, browser


# ---- patch_playwright_for_cdp：纯函数 patch 断言 ----

def test_patch_replaces_launch_with_browser_return() -> None:
    pw, browser = make_pw_with_browser()
    ctx = browser.contexts[0]

    patch_playwright_for_cdp(pw, browser, ctx)

    result = run(pw.chromium.launch(headless=True, channel="chromium"))
    assert result is browser
    # 原始 launch 未被调用（不真正起新浏览器）
    assert pw.chromium.launch_calls == []


def test_patch_new_context_reuses_existing_context() -> None:
    pw, browser = make_pw_with_browser()
    ctx = browser.contexts[0]

    patch_playwright_for_cdp(pw, browser, ctx)

    result = run(browser.new_context(storage_state="/tmp/x.json", permissions=[]))
    assert result is ctx
    # 未真正新建 context（登录态复用）
    assert browser.new_context_calls == []


def test_patch_neutralizes_close_does_not_close_real_browser_or_context() -> None:
    pw, browser = make_pw_with_browser()
    ctx = browser.contexts[0]

    patch_playwright_for_cdp(pw, browser, ctx)

    run(browser.close())
    run(ctx.close())
    assert browser.close_calls == 0
    assert browser.closed is False
    assert ctx.close_calls == 0
    assert ctx.closed is False


def test_patch_returns_original_methods_for_restore() -> None:
    pw, browser = make_pw_with_browser()
    ctx = browser.contexts[0]
    orig_launch = pw.chromium.launch
    orig_new_context = browser.new_context
    orig_browser_close = browser.close
    orig_context_close = ctx.close

    restored = patch_playwright_for_cdp(pw, browser, ctx)

    assert restored["launch"] == orig_launch
    assert restored["new_context"] == orig_new_context
    assert restored["browser_close"] == orig_browser_close
    assert restored["context_close"] == orig_context_close


# ---- cdp_attach：完整上下文管理器（fake async_playwright 工厂注入） ----

def test_cdp_attach_yields_patched_pw_and_connects_over_cdp() -> None:
    browser = FakeBrowser()
    pw = FakePlaywright(browser)
    factory = lambda: FakePlaywrightContext(pw)
    identity = lambda url: url  # 测试注入：不解析 ws 端点，直接传 http 地址
    calls: dict = {}

    async def main() -> None:
        async with cdp_attach(
            "http://127.0.0.1:9222",
            is_local=True,
            playwright_factory=factory,
            resolve_endpoint=identity,
        ) as attached:
            calls["pw"] = attached
            b = await attached.chromium.launch(headless=False)
            calls["browser"] = b
            c = await b.new_context(storage_state="x")
            calls["context"] = c

    run(main())

    assert calls["pw"] is pw
    assert calls["browser"] is browser
    assert calls["context"] is browser.contexts[0]
    # connect_over_cdp 以账号 Chrome 调试端口地址接管
    assert pw.chromium.connect_calls == [("http://127.0.0.1:9222", {})]
    # 退出时不关闭真实 Chrome、不新建 context
    assert browser.close_calls == 0
    assert browser.closed is False
    assert browser.new_context_calls == []
    # playwright 已 stop（断连但不杀浏览器进程）
    assert pw.stopped is True


def test_cdp_attach_exports_storage_state_when_path_given(tmp_path) -> None:
    browser = FakeBrowser()
    pw = FakePlaywright(browser)
    factory = lambda: FakePlaywrightContext(pw)
    identity = lambda url: url
    target = tmp_path / "cookies" / "10.json"

    async def main() -> None:
        async with cdp_attach(
            "http://127.0.0.1:9222",
            is_local=True,
            playwright_factory=factory,
            resolve_endpoint=identity,
            storage_state_path=str(target),
        ):
            pass

    run(main())

    ctx = browser.contexts[0]
    # 登录态导出到上游 account_file（cdp_attach.py: storage_state）
    assert ctx.storage_state_calls == [((), {"path": str(target)})]
    assert target.parent.is_dir()  # cookies 父目录已创建


def test_cdp_attach_stops_playwright_on_error() -> None:
    browser = FakeBrowser()
    pw = FakePlaywright(browser)
    factory = lambda: FakePlaywrightContext(pw)
    identity = lambda url: url

    async def main() -> None:
        with pytest.raises(RuntimeError):
            async with cdp_attach(
                "http://127.0.0.1:9222",
                is_local=True,
                playwright_factory=factory,
                resolve_endpoint=identity,
            ):
                raise RuntimeError("upload failed")

    run(main())
    assert pw.stopped is True
    assert browser.closed is False


# ---- resolve_local_cdp_endpoint：本地 http 地址 → ws 端点（绕过系统代理） ----

def test_resolve_endpoint_passthrough_ws_url() -> None:
    ws = "ws://127.0.0.1:9222/devtools/browser/abc"
    assert resolve_local_cdp_endpoint(ws) == ws


def test_resolve_endpoint_fetches_ws_url_from_local_chrome() -> None:
    ws_url = "ws://127.0.0.1:9999/devtools/browser/xyz"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.startswith("/json/version"):
                body = json.dumps({"webSocketDebuggerUrl": ws_url}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, fmt, *args) -> None:  # 静默
            return

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        assert (
            resolve_local_cdp_endpoint(f"http://127.0.0.1:{port}")
            == ws_url
        )
    finally:
        httpd.shutdown()
        httpd.server_close()
