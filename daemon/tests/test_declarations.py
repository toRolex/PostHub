"""平台声明枚举 ↔ 上游文案映射单测（issue #43 / ADR-0008 决策二）。

`posthub/declarations.py` 是 PostHub 这层「声明类型 → 中文文案」唯一真源；
上游 UI 文本变更时只更新本模块 + 前端镜像表。本测试保证：

- 每个枚举都有登记（非空集合）；
- 每个上游文案非空；
- 任一未知枚举抛 `DeclarationMappingError`（story #22）；
- 平台分流正确（select_for_platform 按官方 type 号取对应平台字段）。
"""

from __future__ import annotations

import pytest

from posthub.declarations import (
    DeclarationMappingError,
    resolve_platform_fields,
    select_for_platform,
)


def _all_enum_values() -> set[str]:
    from posthub.declarations import (
        DOUYIN_DECLARATION_TEXT,
        WECHAT_DECLARATION_TEXT,
        XIAOHONGSHU_SOURCE_TEXT,
    )
    return (
        set(WECHAT_DECLARATION_TEXT)
        | set(DOUYIN_DECLARATION_TEXT)
        | set(XIAOHONGSHU_SOURCE_TEXT)
    )


def test_all_wechat_declarations_have_chinese_text() -> None:
    from posthub.declarations import WECHAT_DECLARATION_TEXT
    for k, v in WECHAT_DECLARATION_TEXT.items():
        assert v, f"视频号文案为空：{k}"
        assert isinstance(v, str)


def test_all_douyin_declarations_have_chinese_text() -> None:
    from posthub.declarations import DOUYIN_DECLARATION_TEXT
    for k, v in DOUYIN_DECLARATION_TEXT.items():
        assert v, f"抖音文案为空：{k}"
        assert isinstance(v, str)


def test_all_xiaohongshu_sources_have_chinese_text() -> None:
    from posthub.declarations import XIAOHONGSHU_SOURCE_TEXT
    for k, v in XIAOHONGSHU_SOURCE_TEXT.items():
        assert v, f"小红书文案为空：{k}"
        assert isinstance(v, str)


def test_resolve_platform_fields_legal_values() -> None:
    resolved = resolve_platform_fields(
        {
            "wechat": {"declaration": "no_label", "origin": True},
            "douyin": {"declaration": "no_need"},
            "xiaohongshu": {"source": "self_declare", "origin": False},
        }
    )
    assert resolved.tencent["declaration"] == "无需标注"
    assert resolved.tencent["origin"] is True
    assert resolved.douyin["declaration"] == "无需添加自主声明"
    assert resolved.xiaohongshu["source"] == "自主拍摄"
    assert resolved.xiaohongshu["origin"] is False


def test_resolve_platform_fields_partial() -> None:
    """只填一个平台 → 其他平台空字典（不污染 select_for_platform）。"""
    resolved = resolve_platform_fields({"douyin": {"declaration": "ai_generated"}})
    assert resolved.douyin["declaration"] == "内容由AI生成"
    assert resolved.tencent == {}
    assert resolved.xiaohongshu == {}


def test_resolve_platform_fields_unknown_raises() -> None:
    """story #22 / #35：非法枚举直接抛错而不是静默成功。"""
    with pytest.raises(DeclarationMappingError) as exc_info:
        resolve_platform_fields({"wechat": {"declaration": "bogus"}})
    assert "wechat.declaration" in str(exc_info.value)
    assert "bogus" in str(exc_info.value)


def test_resolve_platform_fields_empty_input() -> None:
    """空 / None 输入 → 全空 ResolvedDeclarations（无上游文案注入）。"""
    assert resolve_platform_fields(None).tencent == {}
    assert resolve_platform_fields({}).douyin == {}


def test_select_for_platform_routes_correctly() -> None:
    resolved = resolve_platform_fields(
        {
            "wechat": {"declaration": "no_label"},
            "douyin": {"declaration": "no_need"},
            "xiaohongshu": {"source": "self_declare"},
        }
    )
    assert "declaration" in select_for_platform(resolved, 2)  # 视频号
    assert select_for_platform(resolved, 2)["declaration"] == "无需标注"
    assert select_for_platform(resolved, 3)["declaration"] == "无需添加自主声明"  # 抖音
    assert select_for_platform(resolved, 1)["source"] == "自主拍摄"  # 小红书
    # 快手（4）当前无内容声明需求
    assert select_for_platform(resolved, 4) == {}


def test_resolve_platform_fields_origin_must_be_bool() -> None:
    """origin 非 bool → 静默忽略，不抛错（前端 validate 已过滤）。"""
    resolved = resolve_platform_fields(
        {"wechat": {"declaration": "no_label", "origin": "yes"}}  # type: ignore[dict-item]
    )
    # 非法 origin 被忽略，declaration 仍写入
    assert resolved.tencent["declaration"] == "无需标注"
    assert "origin" not in resolved.tencent


def test_uniqueness_of_enum_keys_across_platforms() -> None:
    """三家平台的 key 空间**有意不重叠**（issue #43 spec: 三家语义不对齐）；
    WECHAT_DECLARATION_TEXT 与 DOUYIN_DECLARATION_TEXT 各自独立，避免键冲突误用。
    """
    from posthub.declarations import (
        DOUYIN_DECLARATION_TEXT,
        WECHAT_DECLARATION_TEXT,
        XIAOHONGSHU_SOURCE_TEXT,
    )
    # 视频号与抖音：键集合应有意保持各自平台语义（避免统一键丢精度）
    # 仅校验每个平台至少有一项；重叠与否由 ADR-0008 决定。
    assert len(WECHAT_DECLARATION_TEXT) >= 6
    assert len(DOUYIN_DECLARATION_TEXT) >= 4
    assert len(XIAOHONGSHU_SOURCE_TEXT) >= 4


def test_known_enum_count_matches_spec() -> None:
    """固化各平台枚举总数（与调研 §1.2 / §2.1 / §3.1 一致）：
    视频号 8、抖音 6、小红书 4。
    """
    from posthub.declarations import (
        DOUYIN_DECLARATION_TEXT,
        WECHAT_DECLARATION_TEXT,
        XIAOHONGSHU_SOURCE_TEXT,
    )
    assert len(WECHAT_DECLARATION_TEXT) == 8
    assert len(DOUYIN_DECLARATION_TEXT) == 6
    assert len(XIAOHONGSHU_SOURCE_TEXT) == 4


def test_douyin_no_need_label() -> None:
    """抖音「无需添加自主声明」是合法的回避项（user story #11 关键路径）。"""
    resolved = resolve_platform_fields({"douyin": {"declaration": "no_need"}})
    assert resolved.douyin["declaration"] == "无需添加自主声明"


def test_wechat_no_label_label() -> None:
    """视频号「无需标注」是合法的回避项（user story #3 关键路径）。

    上游原 try-list 不含此文案；PostHub wrapper 必须能透传。
    """
    resolved = resolve_platform_fields({"wechat": {"declaration": "no_label"}})
    assert resolved.tencent["declaration"] == "无需标注"