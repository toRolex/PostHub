"""social-auto-upload 上游 `post_video_*` 函数包装层（issue #43 / ADR-0008）。

social-auto-upload 上游的 `myUtils.postVideo.post_video_DouYin / _tencent / _xhs`
**不接受 `declaration` 形参**（commit 008e4ff6 实测），但其底层
`DouYinVideo` / `TencentVideo` 类接收。PostHub 这层不修改上游源码（ADR-0006 约束），
而是在 import 时**用 functools.wraps 包装函数引用**，把 PostHub 解析好的
`platform_fields.<platform>` 文案当作默认参数注入。

运行时：
- `set_pending_declarations(items)` 在 `/postVideo` 入口把当前 batch 解析出的
  declaration 写入 thread-local 队列；
- 包装函数 pop 一个声明后传入底层类构造函数。
- 队列空则不传 declaration（与未启用声明透传等价）。

`xiaohongshu` 上游无 source 字段代码（实测，调研 §2.2），包装仅做「不传错」语义，
DOM 兜底留给后续 wrapper；目前小红书透传只保存到 PostHub 任务元数据。
"""

from __future__ import annotations

import asyncio
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable

import myUtils.postVideo as _post_video_mod
from conf import BASE_DIR
from uploader.douyin_uploader.main import DouYinVideo
from uploader.tencent_uploader.main import TencentVideo
from utils.files_times import generate_schedule_time_next_day


# ─────────────────────────── thread-local 声明队列 ───────────────────────────
#
# 一个 HTTP /postVideoBatch 提交可能展开多个平台子任务；每个子任务 push 一条
# resolved dict 到队列；包装函数按 FIFO 取用。每个 HTTP 请求对应一个队列。

_local = threading.local()


def _queue() -> deque:
    q = getattr(_local, "queue", None)
    if q is None:
        q = deque()
        _local.queue = q
    return q


def set_pending_declarations(items: list[dict]) -> None:
    """替换当前线程队列；`items` 每项形如 `{platform: 2, tencent: {...}, douyin: {...}}`。

    空 list 表示未声明任何声明——包装函数行为退化为上游默认（视频号不强行点回避）。
    """
    q = _queue()
    q.clear()
    for it in items:
        q.append(it)


def _pop_for(platform: int) -> dict | None:
    """按 FIFO 取一条匹配 platform 的声明；若无匹配则返回 None。"""
    q = _queue()
    for i, it in enumerate(q):
        if it.get("platform") == platform:
            del q[i]
            return it
    return None


# ─────────────────────────── 上游函数包装 ───────────────────────────


def _path_list(values, subdir: str) -> list[Path]:
    return [Path(BASE_DIR / subdir / v) for v in values]


def _inject_declaration_to_douyin(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any,
    enableTimer: bool,
    videos_per_day: int,
    daily_times: Any,
    start_days: int,
    thumbnail_path: str,
    productLink: str,
    productTitle: str,
) -> None:
    """包装 `post_video_DouYin`：在 `DouYinVideo(...)` 调用前注入 declaration。

    调用形态与上游 `post_video_DouYin` 完全对齐（参数顺序、命名）；
    只在末尾按需追加 `declaration=...` 关键字参数。
    """
    resolved = _pop_for(3)  # 3=抖音
    cookies = _path_list(account_file, "cookiesFile")
    video_files = _path_list(files, "videoFile")
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(video_files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0] * len(video_files)
    declaration = (resolved or {}).get("douyin", {}).get("declaration")
    for index, file in enumerate(video_files):
        for cookie in cookies:
            app = DouYinVideo(
                title,
                str(file),
                tags,
                publish_datetimes[index],
                cookie,
                thumbnail_path,
                productLink,
                productTitle,
                declaration=declaration,
            )
            asyncio.run(app.douyin_upload_video(), debug=False)


def _inject_declaration_to_tencent(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any,
    enableTimer: bool,
    videos_per_day: int,
    daily_times: Any,
    start_days: int,
    is_draft: bool,
) -> None:
    """包装 `post_video_tencent`：腾讯`TencentVideo.__init__` 当前不接收
    declaration 形参（上游实测）；包装仅消费平台队列项以避免跨平台串台。
    DOM 层强点「无需标注」等枚举待后续 PostHub wrapper 补。
    """
    _pop_for(2)  # 2=视频号；消费队列项防止跨平台串台
    cookies = _path_list(account_file, "cookiesFile")
    video_files = _path_list(files, "videoFile")
    if enableTimer:
        publish_datetimes = generate_schedule_time_next_day(
            len(video_files), videos_per_day, daily_times, start_days
        )
    else:
        publish_datetimes = [0] * len(video_files)
    for index, file in enumerate(video_files):
        for cookie in cookies:
            app = TencentVideo(
                title,
                str(file),
                tags,
                publish_datetimes[index],
                cookie,
                category,
                is_draft,
            )
            asyncio.run(app.main(), debug=False)


def _inject_declaration_to_xhs(
    title: str,
    files: list[str],
    tags: list[str] | None,
    account_file: list[str],
    category: Any,
    enableTimer: bool,
    videos_per_day: int,
    daily_times: Any,
    start_days: int,
) -> None:
    """包装 `post_video_xhs`：上游零 source 字段代码，wrapper 仅做语义占位；
    DOM 兜底由 PostHub 后续 wrapper 层做（小红书 `XiaoHongShuVideo` 类后续支持）。"""
    _pop_for(1)  # 1=小红书；当前透传打嗝不影响
    return _post_video_mod.post_video_xhs(
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


# ─────────────────────────── 绑定（一次性 import 时执行） ───────────────────────────


def install() -> None:
    """用包装函数替换 `myUtils.postVideo` 三个目标函数。

    使用 `setattr` 覆盖模块属性，sau_backend.py 顶部
    `from myUtils.postVideo import post_video_DouYin` 等已经持有原引用——必须
    同步更新模块级符号。PostHub 自身 `run_backend.py` 在 import sau_backend
    前调用本函数，确保替换在 sau_backend 解析 import 时已生效。
    """
    setattr(_post_video_mod, "post_video_DouYin", _inject_declaration_to_douyin)
    setattr(_post_video_mod, "post_video_tencent", _inject_declaration_to_tencent)
    setattr(_post_video_mod, "post_video_xhs", _inject_declaration_to_xhs)
    # 同步到 sau_backend 模块符号（其 from-import 已固化为局部引用）
    import sau_backend as _sb
    _sb.post_video_DouYin = _inject_declaration_to_douyin
    _sb.post_video_tencent = _inject_declaration_to_tencent
    _sb.post_video_xhs = _inject_declaration_to_xhs