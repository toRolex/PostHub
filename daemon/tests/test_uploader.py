"""最小 upload 链路测试（issue #20）。

- `build_uploader`：按平台实例化上游 uploader（DouYinVideo / XiaoHongShuVideo / TencentVideo），
  验证 PostHub 的 conf 模块可被上游 `import conf` 使用（BASE_DIR 为 Path）。
- `UpstreamUploadExecutor`：build_uploader → cdp_attach 接管账号 Chrome → app.upload(pw)。
  单测用 fake uploader + fake attach 断言调用链；真实 upload（真实 Chrome + 登录态）属 #11。
"""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from posthub.engine import (
    AccountContext,
    ExecutionContext,
    TaskSpec,
)
from posthub.uploader import (
    UpstreamUploadExecutor,
    account_cookie_file,
    build_uploader,
    resolve_headless,
)


def run(coro):
    return asyncio.run(coro)


def make_spec(**overrides) -> TaskSpec:
    base = dict(
        task_id="task-1",
        platform="douyin",
        account_id="acc-1",
        video_path="/tmp/video.mp4",
        title="标题",
        caption="正文",
        tags=("t1", "t2"),
    )
    base.update(overrides)
    return TaskSpec(**base)


def make_context(cdp_url: str = "http://127.0.0.1:9222") -> ExecutionContext:
    return ExecutionContext(
        account=AccountContext(
            account_id="acc-1",
            platform="douyin",
            cdp_url=cdp_url,
        )
    )


# ---- account_cookie_file ----

def test_account_cookie_file_under_data_dir_cookies() -> None:
    path = account_cookie_file("acc-1")
    assert path.endswith("acc-1.json")
    assert "cookies" in path
    assert path.startswith("/")  # 绝对路径


# ---- build_uploader：按平台实例化上游 uploader（需 conf.BASE_DIR 为 Path 可被上游 import） ----

def test_build_uploader_douyin_returns_DouYinVideo() -> None:
    spec = make_spec(tags=("t1", "t2"))
    app = build_uploader("douyin", spec)

    assert type(app).__name__ == "DouYinVideo"
    assert app.title == "标题"
    assert app.file_path == "/tmp/video.mp4"
    assert app.tags == ["t1", "t2"]
    assert app.desc == "正文"
    assert app.publish_strategy == "immediate"
    assert hasattr(app, "upload")  # 统一 seam：app.upload(pw)


def test_build_uploader_xiaohongshu_returns_XiaoHongShuVideo() -> None:
    spec = make_spec(platform="xiaohongshu")
    app = build_uploader("xiaohongshu", spec)
    assert type(app).__name__ == "XiaoHongShuVideo"
    assert app.title == "标题"
    assert hasattr(app, "upload")


def test_build_uploader_wechat_returns_TencentVideo() -> None:
    spec = make_spec(platform="wechat")
    app = build_uploader("wechat", spec)
    assert type(app).__name__ == "TencentVideo"
    assert app.title == "标题"
    assert hasattr(app, "upload")


def test_build_uploader_unknown_platform_raises() -> None:
    with pytest.raises(KeyError):
        build_uploader("bogus", make_spec())


# ---- UpstreamUploadExecutor：build_uploader → cdp_attach → app.upload(pw) ----

class FakeApp:
    def __init__(self) -> None:
        self.uploads: list = []

    async def upload(self, pw) -> None:
        self.uploads.append(pw)


@contextlib.asynccontextmanager
async def fake_attach(cdp_url: str, *, is_local: bool = True, **kwargs):
    yield "fake-pw"


def test_executor_calls_build_uploader_and_attach_and_upload() -> None:
    captured: dict = {}
    app = FakeApp()

    def factory(platform, spec):
        captured["platform"] = platform
        captured["spec"] = spec
        return app

    ex = UpstreamUploadExecutor(uploader_factory=factory, attach=fake_attach)
    spec = make_spec()
    result = run(ex.upload(spec, make_context()))

    assert result.ok is True
    assert captured["platform"] == "douyin"
    assert captured["spec"] is spec
    assert app.uploads == ["fake-pw"]  # 上游 100% 编排拿到的是 CDP 接管的 pw


def test_executor_attaches_with_account_cdp_url_and_is_local() -> None:
    captured: dict = {}

    @contextlib.asynccontextmanager
    async def attach(cdp_url: str, *, is_local: bool = True, **kwargs):
        captured["url"] = cdp_url
        captured["is_local"] = is_local
        yield "fake-pw"

    ex = UpstreamUploadExecutor(uploader_factory=lambda p, s: FakeApp(), attach=attach)
    run(ex.upload(make_spec(), make_context("http://127.0.0.1:9333")))

    assert captured["url"] == "http://127.0.0.1:9333"
    assert captured["is_local"] is True


def test_executor_maps_uploader_exception_to_unknown() -> None:
    class BoomApp:
        async def upload(self, pw) -> None:
            raise RuntimeError("boom")

    ex = UpstreamUploadExecutor(
        uploader_factory=lambda p, s: BoomApp(), attach=fake_attach
    )
    result = run(ex.upload(make_spec(), make_context()))

    assert result.ok is False
    assert result.error_type == "unknown"
    assert result.message == "boom"


# ---- resolve_headless：强风控平台默认可见浏览器，配置可覆盖（issue #21 seam #2） ----

class FakeConf:
    """测试用 conf：提供 LOCAL_CHROME_HEADLESS 字段。"""

    def __init__(self, headless: bool) -> None:
        self.LOCAL_CHROME_HEADLESS = headless


def test_resolve_headless_high_risk_platforms_visible_by_default() -> None:
    from posthub.uploader import HIGH_RISK_PLATFORMS

    # 本域判定：三平台全部强风控（CONTEXT.md 平台约束注册表），默认可见（headless=False）
    assert HIGH_RISK_PLATFORMS == {"douyin", "xiaohongshu", "wechat"}
    for platform in ("douyin", "xiaohongshu", "wechat"):
        assert resolve_headless(platform, FakeConf(headless=False)) is False


def test_resolve_headless_config_override_to_headless() -> None:
    # 用户显式设置 LOCAL_CHROME_HEADLESS=True → 覆盖平台默认，全部后台运行
    assert resolve_headless("douyin", FakeConf(headless=True)) is True
    assert resolve_headless("xiaohongshu", FakeConf(headless=True)) is True


def test_resolve_headless_non_risk_platform_headless_by_default() -> None:
    # 未来非强风控平台：默认 headless=True（静默），仅强风控平台默认可见
    assert resolve_headless("kuaishou", FakeConf(headless=False)) is True


def test_build_uploader_uses_resolve_headless_visible_for_douyin() -> None:
    # 集成：build_uploader 按 resolve_headless 决策 headless（抖音强风控默认可见）
    spec = make_spec()
    app = build_uploader("douyin", spec)
    assert app.headless is False

