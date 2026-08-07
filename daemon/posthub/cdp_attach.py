"""CDP 接管 wrapper（issue #20）：patch chromium.launch → connect_over_cdp。

PostHub 不 fork 上游的唯一注入面（CONTEXT.md / ADR-0001 §上传执行）：

    async with cdp_attach(f"http://127.0.0.1:{account.cdp_port}", is_local=True) as pw:
        await app.upload(pw)   # 上游 100% 编排（T1 方案 B）

patch 行为（`patch_playwright_for_cdp`，纯函数，可单测断言）：

- `pw.chromium.launch` → 返回已连接的账号 Chrome（`connect_over_cdp`），代替新起浏览器；
- `browser.new_context` → 复用已连接的 context（登录态天然持久化，不掉 profile）；
- `browser.close()` / `context.close()` → 中和为 no-op（不关闭真实 Chrome、不掉登录态）。

真实 Chrome 连接与真实 upload 属 #11 验收门；本模块保证 wrapper 代码就绪 + 单测覆盖。
"""

from __future__ import annotations

import contextlib
import json
import urllib.request
from typing import Any, AsyncIterator, Callable

try:  # patchright 是上游 social-auto-upload 的依赖，缺失时仅 cdp_attach 运行期报错
    from patchright.async_api import async_playwright
except ImportError:  # pragma: no cover - 仅测试缺依赖时兜底
    async_playwright = None  # type: ignore[assignment]

__all__ = ["cdp_attach", "patch_playwright_for_cdp", "resolve_local_cdp_endpoint"]


def resolve_local_cdp_endpoint(cdp_url: str) -> str:
    """把本机账号 Chrome 的 http 调试地址解析为 `ws://` 端点。

    驱动（node）fetch `/json/version` 时会走系统代理（本机 shell 常配 http_proxy），
    代理对 CDP 端点返回 400；这里由本进程本地直连（ProxyHandler({}) 绕过代理）取
    `webSocketDebuggerUrl`，再把 ws URL 交给 `connect_over_cdp`。已是 ws URL 则原样返回。
    """
    if cdp_url.startswith("ws://") or cdp_url.startswith("wss://"):
        return cdp_url
    version_url = cdp_url.rstrip("/") + "/json/version"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(version_url, headers={"User-Agent": "posthub-daemon/0.1"})
    with opener.open(req, timeout=5) as resp:
        info = json.loads(resp.read().decode("utf-8"))
    return info["webSocketDebuggerUrl"]


def patch_playwright_for_cdp(pw, browser, context) -> dict[str, Any]:
    """把 Playwright 实例 patch 为 CDP 接管形态；返回原方法以便还原。

    参数用鸭子类型（duck-typing），便于单测注入假 pw/browser/context 断言 patch 生效。
    """
    original_launch = pw.chromium.launch
    original_new_context = browser.new_context
    original_browser_close = browser.close
    original_context_close = context.close

    async def _patched_launch(*args, **kwargs):  # noqa: ARG001
        return browser

    async def _patched_new_context(*args, **kwargs):  # noqa: ARG001
        return context

    async def _noop_close(*args, **kwargs):  # noqa: ARG001
        return None

    pw.chromium.launch = _patched_launch
    browser.new_context = _patched_new_context
    browser.close = _noop_close
    context.close = _noop_close

    return {
        "launch": original_launch,
        "new_context": original_new_context,
        "browser_close": original_browser_close,
        "context_close": original_context_close,
    }


@contextlib.asynccontextmanager
async def cdp_attach(
    cdp_url: str,
    *,
    is_local: bool = True,
    playwright_factory: Callable | None = None,
    resolve_endpoint: Callable | None = None,
) -> AsyncIterator[Any]:
    """接管账号 Chrome：CDP 连接代替上游自行 launch，复用登录态。

    - `cdp_url`：账号 Chrome 调试端口地址（如 `http://127.0.0.1:9222`）。
    - `is_local`：为 True 时连接本机账号 Chrome，先把 http 地址解析为 `ws://` 端点
      （绕过系统代理，见 `resolve_local_cdp_endpoint`）；False 时原样交给驱动。
    - `playwright_factory` / `resolve_endpoint`：测试注入点。

    yield 的 `pw` 是已 patch 的 Playwright 实例，上游 `app.upload(pw)` 100% 编排。
    退出时仅断开 CDP 连接（`pw.stop()`），不关闭真实 Chrome（browser.close 已中和）。
    """
    factory = playwright_factory or async_playwright
    if factory is None:  # pragma: no cover - patchright 未安装
        raise RuntimeError("patchright 未安装，无法接管账号 Chrome")
    resolver = resolve_endpoint or resolve_local_cdp_endpoint
    endpoint = resolver(cdp_url) if is_local else cdp_url
    pw = await factory().start()
    browser = None
    try:
        browser = await pw.chromium.connect_over_cdp(endpoint)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        patch_playwright_for_cdp(pw, browser, context)
        yield pw
    finally:
        try:
            if browser is not None:
                await browser.close()  # 已被中和为 no-op：只断连不关 Chrome
        except Exception:  # pragma: no cover - 尽力清理，不掩盖上传结果
            pass
        await pw.stop()
