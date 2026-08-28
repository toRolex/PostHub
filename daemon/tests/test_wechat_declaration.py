"""视频号内容声明 DOM wrapper 的 stub page 契约。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from patchright.async_api import TimeoutError as PatchrightTimeoutError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from posthub import uploader_wrapper


def run(coro: Any) -> Any:
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clear_diagnostics() -> None:
    uploader_wrapper.clear_declaration_diagnostics()


class StubLocator:
    def __init__(
        self,
        *,
        text: str,
        visible: bool = True,
        present: bool = True,
        click_error: Exception | None = None,
        post_click_text: str | None = None,
        inner_text_error: Exception | None = None,
        count_error: Exception | None = None,
        visible_error: Exception | None = None,
    ) -> None:
        self.text = text
        self.visible = visible
        self.present = present
        self.click_error = click_error
        self.post_click_text = post_click_text
        self.inner_text_error = inner_text_error
        self.count_error = count_error
        self.visible_error = visible_error
        self.clicks = 0

    @property
    def first(self) -> StubLocator:
        return self

    async def count(self) -> int:
        if self.count_error is not None:
            raise self.count_error
        return 1 if self.present else 0

    async def is_visible(self) -> bool:
        if self.visible_error is not None:
            raise self.visible_error
        return self.visible

    async def click(self) -> None:
        self.clicks += 1
        if self.click_error is not None:
            raise self.click_error
        if self.post_click_text is not None:
            self.text = self.post_click_text

    async def inner_text(self) -> str:
        if self.inner_text_error is not None:
            raise self.inner_text_error
        return self.text


class StubPage:
    def __init__(
        self,
        *,
        entries: dict[str, StubLocator] | None = None,
        options: dict[str, StubLocator] | None = None,
    ) -> None:
        self.entries = entries or {}
        self.options = options or {}
        self.screenshots: list[str] = []

    def locator(self, selector: str) -> StubLocator:
        return self.entries.get(
            selector, StubLocator(text="", visible=False, present=False)
        )

    def get_by_text(self, text: str, *, exact: bool = False) -> StubLocator:
        assert exact
        return self.options.get(
            text, StubLocator(text=text, visible=False, present=False)
        )

    async def screenshot(self, *, path: str, full_page: bool = True) -> None:
        assert full_page
        self.screenshots.append(path)


def test_wechat_no_label_uses_second_entry_selector_and_records_display_value(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="添加声明"': StubLocator(text="添加声明"),
        },
        options={"无需标注": StubLocator(text="无需标注")},
    )

    run(
        uploader_wrapper._apply_tencent_content_declaration(
            page, "无需标注", account_file="wechat-account.json", debug_dir=tmp_path
        )
    )

    assert page.entries['text="添加声明"'].clicks == 1
    assert page.options["无需标注"].clicks == 1
    assert uploader_wrapper.get_declaration_diagnostics() == [
        {
            "level": "info",
            "kind": "wechat_content_declaration",
            "account": "wechat-account.json",
            "selector": 'text="添加声明"',
            "requestedValue": "无需标注",
            "displayValue": "无需标注",
        }
    ]


def test_wechat_ai_generated_uses_first_entry_selector(tmp_path: Path) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={"含AI生成内容": StubLocator(text="含AI生成内容")},
    )

    run(
        uploader_wrapper._apply_tencent_content_declaration(
            page, "含AI生成内容", account_file="wechat-ai.json", debug_dir=tmp_path
        )
    )

    assert page.entries['text="内容声明"'].clicks == 1
    assert page.options["含AI生成内容"].clicks == 1


def test_wechat_declaration_diagnostics_accumulate_within_one_item(
    tmp_path: Path,
) -> None:
    uploader_wrapper.clear_declaration_diagnostics()
    first_page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={"无需标注": StubLocator(text="无需标注")},
    )
    second_page = StubPage(
        entries={'text="添加声明"': StubLocator(text="添加声明")},
        options={"含AI生成内容": StubLocator(text="含AI生成内容")},
    )

    run(
        uploader_wrapper._apply_tencent_content_declaration(
            first_page, "无需标注", account_file="first.json", debug_dir=tmp_path
        )
    )
    run(
        uploader_wrapper._apply_tencent_content_declaration(
            second_page, "含AI生成内容", account_file="second.json", debug_dir=tmp_path
        )
    )

    diagnostics = uploader_wrapper.get_declaration_diagnostics()
    assert [item["account"] for item in diagnostics] == ["first.json", "second.json"]
    assert [item["displayValue"] for item in diagnostics] == [
        "无需标注",
        "含AI生成内容",
    ]


def test_wechat_missing_entry_warns_screenshots_and_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(text="内容声明", visible=False),
            'text="添加声明"': StubLocator(text="添加声明", visible=False),
        }
    )

    with pytest.raises(RuntimeError, match="存在但不可见"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="missing.json", debug_dir=tmp_path
            )
        )

    diagnostics = uploader_wrapper.get_declaration_diagnostics()
    assert diagnostics[0]["level"] == "warning"
    assert diagnostics[0]["account"] == "missing.json"
    assert diagnostics[0]["reason"] == "entry_present_hidden"
    assert diagnostics[0]["selector"] == 'text="内容声明"'
    assert diagnostics[0]["screenshot"] == page.screenshots[0]


def test_wechat_missing_option_warns_screenshots_and_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(entries={'text="内容声明"': StubLocator(text="内容声明")})

    with pytest.raises(RuntimeError, match="选项不可用"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page,
                "含AI生成内容",
                account_file="option-missing.json",
                debug_dir=tmp_path,
            )
        )

    diagnostics = uploader_wrapper.get_declaration_diagnostics()
    assert diagnostics[0]["reason"] == "option_unavailable"
    assert diagnostics[0]["selectors"] == [
        "get_by_text(text='含AI生成内容', exact=True)",
        'text="含AI生成内容"',
    ]
    assert diagnostics[0]["screenshot"] == page.screenshots[0]


def test_wechat_present_hidden_option_is_not_reported_as_unmatched(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={"含AI生成内容": StubLocator(text="含AI生成内容", visible=False)},
    )

    with pytest.raises(RuntimeError, match="选项存在但不可见"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page,
                "含AI生成内容",
                account_file="hidden-option.json",
                debug_dir=tmp_path,
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "option_present_hidden"
    assert diagnostic["selector"] == "get_by_text(text='含AI生成内容', exact=True)"
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_entry_click_failure_warns_screenshots_and_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(
                text="内容声明", click_error=RuntimeError("detached")
            )
        }
    )

    with pytest.raises(RuntimeError, match="入口点击失败"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="entry-click.json", debug_dir=tmp_path
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "entry_click_failed"
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_option_click_failure_warns_screenshots_and_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={
            "含AI生成内容": StubLocator(
                text="含AI生成内容", click_error=RuntimeError("detached")
            )
        },
    )

    with pytest.raises(RuntimeError, match="选项点击失败"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page,
                "含AI生成内容",
                account_file="option-click.json",
                debug_dir=tmp_path,
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "option_click_failed"
    assert diagnostic["selector"] == "get_by_text(text='含AI生成内容', exact=True)"
    assert diagnostic["entrySelector"] == 'text="内容声明"'
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_empty_display_value_after_click_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={"无需标注": StubLocator(text="无需标注", post_click_text="")},
    )

    with pytest.raises(RuntimeError, match="最终展示值"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="empty-display.json", debug_dir=tmp_path
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["level"] == "warning"
    assert diagnostic["reason"] == "display_value_unverified"
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_display_value_read_failure_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={
            "含AI生成内容": StubLocator(
                text="含AI生成内容", inner_text_error=RuntimeError("detached")
            )
        },
    )

    with pytest.raises(RuntimeError, match="最终展示值"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page,
                "含AI生成内容",
                account_file="display-read-fail.json",
                debug_dir=tmp_path,
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "display_value_unverified"
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_display_value_mismatch_fails_closed(tmp_path: Path) -> None:
    page = StubPage(
        entries={'text="内容声明"': StubLocator(text="内容声明")},
        options={
            "无需标注": StubLocator(text="无需标注", post_click_text="含营销广告")
        },
    )

    with pytest.raises(RuntimeError, match="最终展示值"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="mismatch.json", debug_dir=tmp_path
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "display_value_mismatch"
    assert diagnostic["displayValue"] == "含营销广告"
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_declaration_context_does_not_leak_after_dom_failure() -> None:
    page = StubPage()
    uploader_wrapper.clear_declaration_diagnostics()

    with (
        pytest.raises(RuntimeError),
        uploader_wrapper._declaration_context(
            {"platform": 2, "fields": {"declaration": "无需标注"}}
        ),
    ):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="failed.json"
            )
        )

    assert uploader_wrapper._active_fields(2) == {}


def test_wechat_both_entry_selectors_missing_are_explicitly_reported() -> None:
    page = StubPage()

    with pytest.raises(RuntimeError, match="双 selector"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="both-missing.json"
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "entry_selectors_unmatched"
    assert diagnostic["selectors"] == [
        'text="内容声明"',
        'text="添加声明"',
    ]


@pytest.mark.parametrize(
    "timeout_error",
    [
        pytest.param(PlaywrightTimeoutError("playwright timeout"), id="playwright"),
        pytest.param(PatchrightTimeoutError("patchright timeout"), id="patchright"),
    ],
)
def test_wechat_recoverable_entry_probe_timeout_falls_back_to_second_selector(
    tmp_path: Path, timeout_error: Exception
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(text="内容声明", count_error=timeout_error),
            'text="添加声明"': StubLocator(text="添加声明"),
        },
        options={"无需标注": StubLocator(text="无需标注")},
    )

    run(
        uploader_wrapper._apply_tencent_content_declaration(
            page, "无需标注", account_file="fallback.json", debug_dir=tmp_path
        )
    )

    assert uploader_wrapper.get_declaration_diagnostics()[0]["selector"] == (
        'text="添加声明"'
    )


def test_wechat_entry_probe_programming_error_is_reported_not_downgraded(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(
                text="内容声明", count_error=RuntimeError("locator bug")
            ),
            'text="添加声明"': StubLocator(text="添加声明"),
        }
    )

    with pytest.raises(RuntimeError, match="locator bug"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="probe-error.json", debug_dir=tmp_path
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "entry_probe_failed"
    assert diagnostic["selector"] == 'text="内容声明"'
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_present_hidden_entry_is_not_reported_as_unmatched(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(text="内容声明", visible=False),
        }
    )

    with pytest.raises(RuntimeError, match="存在但不可见"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="hidden.json", debug_dir=tmp_path
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "entry_present_hidden"
    assert diagnostic["selector"] == 'text="内容声明"'
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_option_probe_programming_error_is_reported_not_downgraded(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(text="内容声明"),
            'text="无需标注"': StubLocator(
                text="无需标注", count_error=RuntimeError("option locator bug")
            ),
        }
    )

    with pytest.raises(RuntimeError, match="option locator bug"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page,
                "无需标注",
                account_file="option-probe-error.json",
                debug_dir=tmp_path,
            )
        )

    diagnostic = uploader_wrapper.get_declaration_diagnostics()[0]
    assert diagnostic["reason"] == "option_probe_failed"
    assert diagnostic["selector"] == 'text="无需标注"'
    assert diagnostic["screenshot"] == page.screenshots[0]


def test_wechat_recovers_menu_left_open_by_upstream_statement_step(
    tmp_path: Path,
) -> None:
    class MenuPage:
        def __init__(self) -> None:
            self.menu_open = True
            self.entry = MenuLocator(self, "内容声明")
            self.option = MenuLocator(self, "无需标注")
            self.screenshots: list[str] = []

        def locator(self, selector: str) -> MenuLocator:
            if selector == 'text="内容声明"':
                return self.entry
            if selector == 'text="无需标注"':
                return self.option
            return MenuLocator(self, "", present=False, visible=False)

        def get_by_text(self, text: str, *, exact: bool = False) -> MenuLocator:
            assert exact
            return (
                self.option
                if text == "无需标注"
                else MenuLocator(self, "", present=False, visible=False)
            )

        async def screenshot(self, *, path: str, full_page: bool = True) -> None:
            assert full_page
            self.screenshots.append(path)

    class MenuLocator:
        def __init__(
            self,
            page: MenuPage,
            text: str,
            *,
            present: bool = True,
            visible: bool = True,
        ) -> None:
            self.page = page
            self.text = text
            self._present = present
            self._visible = visible
            self.clicks = 0

        @property
        def first(self) -> MenuLocator:
            return self

        async def count(self) -> int:
            if self.text == "无需标注":
                return int(self.page.menu_open)
            return int(self._present)

        async def is_visible(self) -> bool:
            if self.text == "无需标注":
                return self.page.menu_open
            return self._visible

        async def click(self) -> None:
            self.clicks += 1
            if self.text == "内容声明":
                self.page.menu_open = not self.page.menu_open
            else:
                self.page.menu_open = False

        async def inner_text(self) -> str:
            return self.text

    page = MenuPage()
    run(
        uploader_wrapper._apply_tencent_content_declaration(
            page, "无需标注", account_file="upstream-open.json", debug_dir=tmp_path
        )
    )

    assert page.entry.clicks == 2
    assert page.option.clicks == 1
    assert (
        uploader_wrapper.get_declaration_diagnostics()[0]["displayValue"] == "无需标注"
    )
