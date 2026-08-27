"""social-auto-upload 上游发布函数的 PostHub 薄包装层（issue #43 / ADR-0008）。

上游 ``myUtils.postVideo`` 的函数签名不接收 PostHub 声明字段。这里保留上游
发布函数与执行循环，只在其调用上下文中把声明注入上游上传类；因此不会复制
官方的文件/账号遍历、定时或异常处理逻辑。

运行时：
- ``set_pending_declarations(items)`` 在 HTTP 入口按请求写入 thread-local 队列；
- 包装函数取出当前平台的一项，在委托官方函数时设置 thread-local 上下文；
- 上传类代理从该上下文读取声明，抖音传给官方构造函数，视频号通过明确的
  DOM seam 选择内容声明；声明入口不可用时显式失败而不是静默丢弃；
- 请求 teardown 清空队列，避免声明跨请求串扰。

小红书上游当前没有 source 字段执行代码，因此只委托官方函数并保留声明上下文
seam；本 issue 不复制小红书发布流程或另造执行引擎。
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import myUtils.postVideo as _post_video_mod
from flask import has_request_context, request
from uploader.douyin_uploader.main import DouYinVideo as _OriginalDouYinVideo
from uploader.tencent_uploader.main import TencentVideo as _OriginalTencentVideo

from posthub.declarations import resolve_platform_fields, select_for_platform
from posthub.publish_adapter import EffectiveBatchItem, PublishExecutionAdapter

# 在安装 wrapper 前保存官方函数。保存到模块级而不是从被替换的模块属性回调，
# 可避免小红书 wrapper 自递归，也让三家 wrapper 都委托官方执行循环。
_ORIGINAL_POST_VIDEO_DOUYIN = _post_video_mod.post_video_DouYin
_ORIGINAL_POST_VIDEO_TENCENT = _post_video_mod.post_video_tencent
_ORIGINAL_POST_VIDEO_XHS = _post_video_mod.post_video_xhs
_ORIGINAL_POST_VIDEO_KS = _post_video_mod.post_video_ks

_local = threading.local()
_MISSING = object()


def _queue() -> deque:
    q = getattr(_local, "queue", None)
    if q is None:
        q = deque()
        _local.queue = q
    return q


def set_pending_declarations(items: list[dict]) -> None:
    """替换迁移期兼容队列；新声明项使用 canonical shape。

    新项形如 ``{"platform": 2, "fields": {"declaration": "无需标注"}}``；
    `_fields_for()` 仍读取旧平台嵌套和旧 flat fixture。空 list 表示本请求没有声明。
    """
    q = _queue()
    q.clear()
    q.extend(items)


def _effective_queue() -> deque[EffectiveBatchItem]:
    q = getattr(_local, "effective_queue", None)
    if q is None:
        q = deque()
        _local.effective_queue = q
    return q


def set_pending_effective_items(
    items: list[EffectiveBatchItem] | tuple[EffectiveBatchItem, ...],
) -> None:
    """替换当前请求的账号粒度 effective item 队列。"""
    q = _effective_queue()
    q.clear()
    q.extend(items)


def _pop_effective_group(platform: int) -> list[EffectiveBatchItem]:
    """按官方路由一次调用对应的 source item 取出账号拆分结果。"""
    q = _effective_queue()
    first_index = next(
        (index for index, item in enumerate(q) if item.platform_type == platform),
        None,
    )
    if first_index is None:
        return []
    source_index = q[first_index].source_index
    group: list[EffectiveBatchItem] = []
    for index in range(len(q) - 1, -1, -1):
        item = q[index]
        if item.platform_type == platform and item.source_index == source_index:
            group.insert(0, item)
            del q[index]
    return group


def _is_official_publish_request() -> bool:
    """判断当前调用是否来自官方发布路由，供兼容 fallback 设安全边界。"""
    return has_request_context() and request.endpoint in {
        "postVideo",
        "postVideoBatch",
    }


def _pop_effective_group_for_request(platform: int) -> list[EffectiveBatchItem]:
    """HTTP 发布请求缺 effective 时拒绝直调，避免绕过 normalization。"""
    group = _pop_effective_group(platform)
    if not group and _is_official_publish_request():
        raise RuntimeError("官方发布请求缺少规范化 effective item")
    return group


def _declaration_item_for_effective(item: EffectiveBatchItem) -> dict[str, Any]:
    """把 effective 内部枚举转为 wrapper 消费的官方中文字段。"""
    fields = item.effective.get("platformFields")
    if not fields:
        return {"platform": item.platform_type, "fields": {}}
    resolved = resolve_platform_fields(fields)
    selected = select_for_platform(resolved, item.platform_type)
    if not selected:
        return {"platform": item.platform_type, "fields": {}}
    return {"platform": item.platform_type, "fields": selected}


def _pop_for(platform: int) -> dict | None:
    """按 FIFO 取一条匹配平台的声明；若无匹配则返回 None。"""
    q = _queue()
    for index, item in enumerate(q):
        if item.get("platform") == platform:
            del q[index]
            return item
    return None


def _fields_for(item: dict | None, platform: int) -> dict[str, Any]:
    """读取 canonical 声明，并兼容迁移期旧平台嵌套/flat shape。"""
    if not item:
        return {}

    if "fields" in item:
        if item.get("platform") != platform:
            return {}
        fields = item["fields"]
        return fields if isinstance(fields, dict) else {}

    if item.get("platform") is not None and item.get("platform") != platform:
        return {}
    key = {1: "xiaohongshu", 2: "tencent", 3: "douyin"}.get(platform)
    fields = item.get(key) if key else None
    if isinstance(fields, dict):
        return fields
    # 兼容早期组合实现曾产生的 {platform, declaration/source, origin} 形状；
    # 新入口不再产生该形状，但读取兼容避免热更新期间声明丢失。
    if platform == 1:
        allowed = {"source", "origin"}
    elif platform == 2:
        allowed = {"declaration", "origin"}
    elif platform == 3:
        allowed = {"declaration"}
    else:
        allowed = set()
    return {name: item[name] for name in allowed if name in item}


def _active_fields(platform: int) -> dict[str, Any]:
    return _fields_for(getattr(_local, "active", None), platform)


@contextmanager
def _declaration_context(item: dict | None) -> Iterator[None]:
    previous = getattr(_local, "active", _MISSING)
    _local.active = item
    try:
        yield
    finally:
        if previous is _MISSING:
            try:
                del _local.active
            except AttributeError:
                pass
        else:
            _local.active = previous


class _DouYinVideoWithDeclaration(_OriginalDouYinVideo):
    """只扩展构造参数注入，发布生命周期仍由官方类实现。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        declaration = _active_fields(3).get("declaration")
        if declaration is not None and "declaration" not in kwargs:
            kwargs["declaration"] = declaration
        super().__init__(*args, **kwargs)


async def _apply_tencent_content_declaration(page: Any, declaration: str) -> None:
    """视频号内容声明 DOM seam。

    上游 ``TencentVideo`` 当前只尝试少量回避项；PostHub 解析出的具体文案由
    这里负责选择。找不到入口或选项时抛出明确异常，禁止返回“发布成功”却丢声明。
    """
    entry = page.locator('text="内容声明"').first
    if not await entry.count() or not await entry.is_visible():
        raise RuntimeError("视频号内容声明入口不可用，未能应用 PostHub 声明")
    await entry.click()
    option = page.get_by_text(declaration, exact=True).first
    if not await option.count() or not await option.is_visible():
        raise RuntimeError(f"视频号内容声明选项不可用：{declaration}")
    await option.click()


class _TencentVideoWithDeclaration(_OriginalTencentVideo):
    """保留官方上传生命周期，仅在官方声明步骤后接入 PostHub DOM seam。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.posthub_declaration = _active_fields(2).get("declaration")

    async def apply_original_statement(self, page: Any) -> None:
        await super().apply_original_statement(page)
        if self.posthub_declaration:
            await _apply_tencent_content_declaration(page, self.posthub_declaration)


def _normalize_douyin_tail(
    thumbnail_path: str,
    productLink: str,
    productTitle: str,
) -> tuple[str, str, str]:
    """修正官方 batch 路由少传 thumbnail 后造成的尾参数错位。"""
    if has_request_context() and request.endpoint == "postVideoBatch":
        # 官方 batch 调用形态为 (..., start_days, productLink, productTitle)。
        return "", thumbnail_path, productLink
    return thumbnail_path, productLink, productTitle


def _invoke_douyin_command(command: dict[str, Any]) -> None:
    """将一个 effective command 映射到官方抖音函数；不复制官方发布循环。"""
    _ORIGINAL_POST_VIDEO_DOUYIN(
        command["title"],
        command["fileList"],
        command["tags"],
        command["accountList"],
        command.get("category"),
        command.get("enableTimer", False),
        command.get("videosPerDay", 1),
        command.get("dailyTimes"),
        command.get("startDays", 0),
        command.get("thumbnail", ""),
        command.get("productLink", ""),
        command.get("productTitle", ""),
    )


def _invoke_tencent_command(command: dict[str, Any]) -> None:
    """将一个 effective command 映射到官方视频号函数。"""
    _ORIGINAL_POST_VIDEO_TENCENT(
        command["title"],
        command["fileList"],
        command["tags"],
        command["accountList"],
        command.get("category"),
        command.get("enableTimer", False),
        command.get("videosPerDay", 1),
        command.get("dailyTimes"),
        command.get("startDays", 0),
        command.get("isDraft", False),
    )


def _invoke_xhs_command(command: dict[str, Any]) -> None:
    """将一个 effective command 映射到官方小红书函数。"""
    _ORIGINAL_POST_VIDEO_XHS(
        command["title"],
        command["fileList"],
        command["tags"],
        command["accountList"],
        command.get("category"),
        command.get("enableTimer", False),
        command.get("videosPerDay", 1),
        command.get("dailyTimes"),
        command.get("startDays", 0),
    )


def _invoke_ks_command(command: dict[str, Any]) -> None:
    """将一个 effective command 映射到官方快手函数。"""
    _ORIGINAL_POST_VIDEO_KS(
        command["title"],
        command["fileList"],
        command["tags"],
        command["accountList"],
        command.get("category"),
        command.get("enableTimer", False),
        command.get("videosPerDay", 1),
        command.get("dailyTimes"),
        command.get("startDays", 0),
    )


def _execute_effective_group(
    items: list[EffectiveBatchItem],
    invoke: Any,
) -> None:
    """把账号粒度命令交给官方函数，适配器不承担官方内部遍历。"""
    adapter = PublishExecutionAdapter(invoke)
    for item in items:
        with _declaration_context(_declaration_item_for_effective(item)):
            adapter.execute_item(item)


def _inject_declaration_to_douyin(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any = "生活",
    enableTimer: bool = False,
    videos_per_day: int = 1,
    daily_times: Any = None,
    start_days: int = 0,
    thumbnail_path: str = "",
    productLink: str = "",
    productTitle: str = "",
) -> None:
    """委托官方抖音发布函数，并通过官方类构造函数注入声明。"""
    effective_group = _pop_effective_group_for_request(3)
    if effective_group:
        _execute_effective_group(effective_group, _invoke_douyin_command)
        return None

    thumbnail_path, productLink, productTitle = _normalize_douyin_tail(
        thumbnail_path, productLink, productTitle
    )
    with _declaration_context(_pop_for(3)):
        return _ORIGINAL_POST_VIDEO_DOUYIN(
            title,
            files,
            tags,
            account_file,
            category,
            enableTimer,
            videos_per_day,
            daily_times,
            start_days,
            thumbnail_path,
            productLink,
            productTitle,
        )


def _inject_declaration_to_tencent(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any = "生活",
    enableTimer: bool = False,
    videos_per_day: int = 1,
    daily_times: Any = None,
    start_days: int = 0,
    is_draft: bool = False,
) -> None:
    """委托官方视频号发布函数，并通过明确 DOM seam 应用声明。"""
    effective_group = _pop_effective_group_for_request(2)
    if effective_group:
        _execute_effective_group(effective_group, _invoke_tencent_command)
        return None

    with _declaration_context(_pop_for(2)):
        return _ORIGINAL_POST_VIDEO_TENCENT(
            title,
            files,
            tags,
            account_file,
            category,
            enableTimer,
            videos_per_day,
            daily_times,
            start_days,
            is_draft,
        )


def _inject_declaration_to_xhs(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any = "生活",
    enableTimer: bool = False,
    videos_per_day: int = 1,
    daily_times: Any = None,
    start_days: int = 0,
) -> None:
    """委托官方小红书发布函数，避免替换后回调自身造成递归。"""
    effective_group = _pop_effective_group_for_request(1)
    if effective_group:
        _execute_effective_group(effective_group, _invoke_xhs_command)
        return None

    with _declaration_context(_pop_for(1)):
        return _ORIGINAL_POST_VIDEO_XHS(
            title,
            files,
            tags,
            account_file,
            category,
            enableTimer,
            videos_per_day,
            daily_times,
            start_days,
        )


def _inject_effective_to_ks(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any = "生活",
    enableTimer: bool = False,
    videos_per_day: int = 1,
    daily_times: Any = None,
    start_days: int = 0,
) -> None:
    """快手无声明字段，也通过同一 effective 执行入口。"""
    effective_group = _pop_effective_group_for_request(4)
    if effective_group:
        _execute_effective_group(effective_group, _invoke_ks_command)
        return None
    return _ORIGINAL_POST_VIDEO_KS(
        title,
        files,
        tags,
        account_file,
        category,
        enableTimer,
        videos_per_day,
        daily_times,
        start_days,
    )


_INSTALLED = False


def install() -> None:
    """一次性把 PostHub seam wrapper 绑定到官方发布模块及已导入后端。"""
    global _INSTALLED
    if _INSTALLED:
        return

    _post_video_mod.post_video_DouYin = _inject_declaration_to_douyin
    _post_video_mod.post_video_tencent = _inject_declaration_to_tencent
    _post_video_mod.post_video_xhs = _inject_declaration_to_xhs
    _post_video_mod.post_video_ks = _inject_effective_to_ks
    _post_video_mod.DouYinVideo = _DouYinVideoWithDeclaration
    _post_video_mod.TencentVideo = _TencentVideoWithDeclaration

    # sau_backend 使用 from-import，需同步替换其局部函数引用；只改运行时引用，
    # 不改官方副本文件。
    import sau_backend as _sb

    _sb.post_video_DouYin = _inject_declaration_to_douyin
    _sb.post_video_tencent = _inject_declaration_to_tencent
    _sb.post_video_xhs = _inject_declaration_to_xhs
    _sb.post_video_ks = _inject_effective_to_ks
    _INSTALLED = True
