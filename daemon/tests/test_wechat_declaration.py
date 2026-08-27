"""视频号内容声明 DOM wrapper 的 stub page 契约。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from posthub import uploader_wrapper


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class StubLocator:
    def __init__(
        self, *, text: str, visible: bool = True, present: bool = True
    ) -> None:
        self.text = text
        self.visible = visible
        self.present = present
        self.clicks = 0

    @property
    def first(self) -> StubLocator:
        return self

    async def count(self) -> int:
        return 1 if self.present else 0

    async def is_visible(self) -> bool:
        return self.visible

    async def click(self) -> None:
        self.clicks += 1

    async def inner_text(self) -> str:
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
        return self.options.get(text, StubLocator(text=text, visible=False))

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


def test_wechat_missing_entry_warns_screenshots_and_fails_closed(
    tmp_path: Path,
) -> None:
    page = StubPage(
        entries={
            'text="内容声明"': StubLocator(text="内容声明", visible=False),
            'text="添加声明"': StubLocator(text="添加声明", visible=False),
        }
    )

    with pytest.raises(RuntimeError, match="入口未渲染"):
        run(
            uploader_wrapper._apply_tencent_content_declaration(
                page, "无需标注", account_file="missing.json", debug_dir=tmp_path
            )
        )

    diagnostics = uploader_wrapper.get_declaration_diagnostics()
    assert diagnostics[0]["level"] == "warning"
    assert diagnostics[0]["account"] == "missing.json"
    assert diagnostics[0]["reason"] == "entry_unavailable"
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
    assert diagnostics[0]["selector"] == 'text="内容声明"'
    assert diagnostics[0]["screenshot"] == page.screenshots[0]


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
