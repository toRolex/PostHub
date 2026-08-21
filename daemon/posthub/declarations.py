"""平台「内容声明」按平台分键透传（issue #43 / ADR-0008）。

PostHub 这层定义英文枚举值（如 `no_label` / `ai_generated`），通过本模块
映射成 social-auto-upload 上游能识别的中文文案（如 `'无需标注'`），按平台
分别写入 `tencent_video_data` / `douyin_video_data` / `xiaohongshu_video_data`。

上游支持度（实测 2026-08-21，见
`docs/research/2026-08-21-three-platform-aigc-declaration-fields.md`）：
- 抖音 `DouYinVideo.declaration`：全链通（CLI `--declaration` + 单测覆盖）。
- 视频号「添加声明」下拉：上游仅尝试「无需声明 / 不声明 / 无」三个回避项；
  「无需标注」不在候选，PostHub wrapper 层做 DOM 兜底（命中失败时按枚举顺序强点）。
- 小红书「笔记内容声明」：上游零代码，PostHub DOM wrapper 层补。

设计原则：
- 持久化层存英文枚举（不随平台 UI 文案变化失效）；
- 映射集中维护在本文件，便于上游 UI 文案变更时单点更新；
- 非法映射抛 `DeclarationMappingError`，由 `sau_backend.py` 兜底返回 400。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

# ────────────────────────────── 内部枚举 ──────────────────────────────

WechatDeclaration = Literal[
    "no_label",
    "ai_generated",
    "fictional",
    "personal_opinion",
    "marketing",
    "self_shoot",
    "shoot_time_location",
    "repost",
]
DouyinDeclaration = Literal[
    "ai_generated",
    "personal_opinion",
    "repost",
    "marketing",
    "fictional",
    "no_need",
]
# 小红书「创作来源 / 笔记内容声明」上游字段名是 `source`（参见调研 §2.1），
# PostHub 这层用 `XiaohongshuSource` 与上游字面对齐。
XiaohongshuSource = Literal[
    "fictional",
    "ai_synthesized",
    "marketing",
    "self_declare",
]

# ────────────────────────────── 映射表 ──────────────────────────────
# 键 = PostHub 内部枚举；值 = 上游 UI 真实文本（按 `docs/research` 与官方公告抄录）。

WECHAT_DECLARATION_TEXT: Final[dict[str, str]] = {
    "no_label": "无需标注",
    "ai_generated": "含AI生成内容",
    "fictional": "内容为虚构剧情，仅供娱乐",
    "personal_opinion": "个人观点，仅供参考",
    "marketing": "内容包含营销广告",
    "self_shoot": "内容为自行拍摄",
    "shoot_time_location": "添加拍摄时间和地点",
    "repost": "内容为转载",
}

DOUYIN_DECLARATION_TEXT: Final[dict[str, str]] = {
    "ai_generated": "内容由AI生成",
    "personal_opinion": "内容为个人观点或见解",
    "repost": "内容为转载信息",
    "marketing": "内容含营销推广信息",
    "fictional": "虚构演绎，仅供娱乐",
    "no_need": "无需添加自主声明",
}

XIAOHONGSHU_SOURCE_TEXT: Final[dict[str, str]] = {
    "fictional": "虚构演绎仅供娱乐",
    "ai_synthesized": "笔记含AI合成内容",
    "marketing": "已在正文中自主标注",
    "self_declare": "自主拍摄",
}


# ────────────────────────────── 数据类 ──────────────────────────────


@dataclass(frozen=True)
class ResolvedDeclarations:
    """平台声明文案拆解，供 social-auto-upload 上层 dict 注入。

    三家平台分别独立：`tencent` 字段给视频号、`douyin` 给抖音、
    `xiaohongshu` 给小红书。`origin` 是「声明原创」开关（透传 bool，
    不参与合规声明语义），按平台直接放进各自 dict。
    """

    tencent: dict[str, str]
    douyin: dict[str, str]
    xiaohongshu: dict[str, str]


class DeclarationMappingError(ValueError):
    """平台声明枚举/字段非法或未登记——上游 UI 变更后常见。"""


# ────────────────────────────── 映射逻辑 ──────────────────────────────


def _resolve(
    enum_value: str | None,
    table: dict[str, str],
    field_label: str,
) -> str | None:
    """enum → 上游文案；None 视为「未设置」直接透传 None。"""
    if enum_value is None:
        return None
    text = table.get(enum_value)
    if text is None:
        raise DeclarationMappingError(
            f"{field_label} 取值非法：{enum_value!r}（合法候选：{sorted(table)}）"
        )
    return text


def resolve_platform_fields(
    platform_fields: dict | None,
) -> ResolvedDeclarations:
    """把 PostHub `platform_fields` 字典解析成各平台上游文案 + origin。

    参数：来自官方 `/postVideo` 请求体 `platform_fields` 字段（任意 key 缺失视为「未设置」）。
    返回：拆分到三家平台的 dict；上游 dict 注入时按 platform 选择对应字段。
    """
    wechat: dict = (platform_fields or {}).get("wechat") or {}
    douyin: dict = (platform_fields or {}).get("douyin") or {}
    xiaohongshu: dict = (platform_fields or {}).get("xiaohongshu") or {}

    tencent_text = _resolve(wechat.get("declaration"), WECHAT_DECLARATION_TEXT, "wechat.declaration")
    douyin_text = _resolve(douyin.get("declaration"), DOUYIN_DECLARATION_TEXT, "douyin.declaration")
    xhs_text = _resolve(xiaohongshu.get("source"), XIAOHONGSHU_SOURCE_TEXT, "xiaohongshu.source")

    tencent_origin = wechat.get("origin") if isinstance(wechat.get("origin"), bool) else None
    xhs_origin = xiaohongshu.get("origin") if isinstance(xiaohongshu.get("origin"), bool) else None

    tencent: dict[str, str] = {}
    if tencent_text is not None:
        tencent["declaration"] = tencent_text
    if tencent_origin is not None:
        tencent["origin"] = tencent_origin

    douyin_out: dict[str, str] = {}
    if douyin_text is not None:
        douyin_out["declaration"] = douyin_text

    xhs_out: dict[str, str] = {}
    if xhs_text is not None:
        xhs_out["source"] = xhs_text
    if xhs_origin is not None:
        xhs_out["origin"] = xhs_origin

    return ResolvedDeclarations(
        tencent=tencent,
        douyin=douyin_out,
        xiaohongshu=xhs_out,
    )


# ────────────────────────────── 上游注入 ──────────────────────────────


def select_for_platform(
    resolved: ResolvedDeclarations,
    platform: int,
) -> dict[str, str]:
    """按官方 type 号（1=小红书 2=视频号 3=抖音 4=快手）取该平台上游字段。

    快手（4）当前无内容声明需求——返回空 dict 由上游保留默认行为。
    """
    if platform == 2:  # 视频号
        return resolved.tencent
    if platform == 3:  # 抖音
        return resolved.douyin
    if platform == 1:  # 小红书
        return resolved.xiaohongshu
    return {}