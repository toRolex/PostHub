"""四平台 scheduled wrapper 的官方上传类契约测试。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from flask import Flask

import sau_backend
from posthub import uploader_wrapper
from posthub.composition import compose_posthub_backend


@pytest.mark.parametrize(
    ("platform", "class_name", "wrapper_name", "extra"),
    [
        (1, "XiaoHongShuVideo", "_inject_declaration_to_xhs", {}),
        (2, "TencentVideo", "_inject_declaration_to_tencent", {"is_draft": True}),
        (
            3,
            "DouYinVideo",
            "_inject_declaration_to_douyin",
            {
                "thumbnail_path": "cover.jpg",
                "productLink": "https://shop.test/item",
                "productTitle": "商品标题",
            },
        ),
        (4, "KSVideo", "_inject_effective_to_ks", {}),
    ],
)
def test_scheduled_wrappers_pass_strategy_and_start_days_by_contract(
    monkeypatch,
    platform: int,
    class_name: str,
    wrapper_name: str,
    extra: dict[str, Any],
) -> None:
    """整点 timer 必须让官方上传类收到 scheduled 与日期而非 timestamps。"""
    uploader_wrapper.install()
    original_class = getattr(uploader_wrapper, f"_Original{class_name}")
    calls: list[dict[str, Any]] = []

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        publish_date = kwargs.get("publish_date", args[3])
        calls.append(
            {
                "args": args,
                "kwargs": kwargs,
                "publish_date": publish_date,
                "publish_strategy": kwargs.get("publish_strategy"),
            }
        )
        self.publish_date = publish_date
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)
    monkeypatch.setattr(original_class, "douyin_upload_video", fake_main, raising=False)

    wrapper = getattr(uploader_wrapper, wrapper_name)
    uploader_wrapper.set_pending_effective_items([])
    uploader_wrapper.set_pending_declarations([])
    wrapper(
        "标题",
        ["video.mp4"],
        ["tag"],
        ["account.json"],
        category=7,
        enableTimer=True,
        videos_per_day=1,
        daily_times=[10],
        start_days=2,
        **extra,
    )

    assert len(calls) == 1
    call = calls[0]
    assert call["publish_strategy"] == "scheduled"
    publish_date = call["publish_date"]
    assert isinstance(publish_date, datetime)
    assert publish_date.hour == 10
    assert publish_date.minute == 0
    assert publish_date.second == 0
    assert publish_date.microsecond == 0

    if platform == 3:
        assert call["args"][5:8] == (
            "cover.jpg",
            "https://shop.test/item",
            "商品标题",
        )
    if platform == 2:
        assert call["args"][5:7] == (7, True)


def test_xhs_scheduled_wrapper_selects_date_for_each_file(monkeypatch) -> None:
    """小红书官方旧循环传日期列表时，每个文件仍收到自己的日期。"""
    uploader_wrapper.install()
    original_class = uploader_wrapper._OriginalXiaoHongShuVideo
    dates: list[Any] = []

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        dates.append(args[3])
        self.publish_date = args[3]
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)

    uploader_wrapper._inject_declaration_to_xhs(
        "标题",
        ["first.mp4", "second.mp4"],
        [],
        ["account.json"],
        category=7,
        enableTimer=True,
        videos_per_day=2,
        daily_times=[8, 10],
        start_days=1,
    )

    assert len(dates) == 2
    assert all(isinstance(value, datetime) for value in dates)
    assert [value.hour for value in dates] == [8, 10]
    assert dates[0].date() == dates[1].date()


def test_xhs_scheduled_wrapper_preserves_duplicate_file_indices(monkeypatch) -> None:
    """相同文件名重复出现时仍按官方外层文件 index 取日期。"""
    uploader_wrapper.install()
    original_class = uploader_wrapper._OriginalXiaoHongShuVideo
    dates: list[Any] = []

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        dates.append(args[3])
        self.publish_date = args[3]
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)

    uploader_wrapper._inject_declaration_to_xhs(
        "标题",
        ["same.mp4", "same.mp4"],
        [],
        ["account.json"],
        category=7,
        enableTimer=True,
        videos_per_day=2,
        daily_times=[8, 10],
        start_days=1,
    )

    assert [value.hour for value in dates] == [8, 10]


def test_schedule_adapter_passes_start_days_as_named_argument(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def fake_generate(
        total_videos: int,
        *,
        videos_per_day: int,
        daily_times: list[int],
        timestamps: bool,
        start_days: int,
    ) -> list[datetime]:
        captured.update(
            {
                "total_videos": total_videos,
                "videos_per_day": videos_per_day,
                "daily_times": daily_times,
                "timestamps": timestamps,
                "start_days": start_days,
            }
        )
        return [datetime(2030, 1, 1, 10, tzinfo=UTC)]

    monkeypatch.setattr(
        uploader_wrapper, "_ORIGINAL_GENERATE_SCHEDULE_TIME", fake_generate
    )
    result = uploader_wrapper._generate_schedule_with_start_days(1, 1, [10], 2)

    assert result == [datetime(2030, 1, 1, 10, tzinfo=UTC)]
    assert captured == {
        "total_videos": 1,
        "videos_per_day": 1,
        "daily_times": [10],
        "timestamps": False,
        "start_days": 2,
    }


def test_scheduled_wrapper_contract_is_same_for_single_and_batch_effective_items(
    monkeypatch,
) -> None:
    """单发与 batch effective item 必须共享完整抖音 scheduled 参数。"""
    uploader_wrapper.install()
    calls: list[dict[str, Any]] = []

    def fake_douyin(*args: Any, **kwargs: Any) -> None:
        calls.append({"args": args, "kwargs": kwargs})

    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_DOUYIN", fake_douyin)
    payload = {
        "title": "标题",
        "fileList": ["video.mp4"],
        "tags": ["tag"],
        "accountList": ["account.json"],
        "type": 3,
        "category": 7,
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": [10],
        "startDays": 2,
        "thumbnail": "cover.jpg",
        "productLink": "https://shop.test/item",
        "productTitle": "商品标题",
    }
    account = {
        "id": 1,
        "type": 3,
        "filePath": "account.json",
        "userName": "抖音",
        "status": 1,
        "default_platform_fields": None,
    }
    from posthub.publish_adapter import normalize_publish_payloads

    normalized = normalize_publish_payloads([payload], [account])
    item = normalized.effective[0]
    uploader_wrapper.set_pending_effective_items([item])
    uploader_wrapper._inject_declaration_to_douyin(
        "标题",
        ["video.mp4"],
        ["tag"],
        ["account.json"],
        category=7,
        enableTimer=True,
        videos_per_day=1,
        daily_times=[10],
        start_days=2,
        thumbnail_path="cover.jpg",
        productLink="https://shop.test/item",
        productTitle="商品标题",
    )
    uploader_wrapper.set_pending_effective_items([item])
    uploader_wrapper._inject_declaration_to_douyin(
        "标题",
        ["video.mp4"],
        ["tag"],
        ["account.json"],
        category=7,
        enableTimer=True,
        videos_per_day=1,
        daily_times=[10],
        start_days=2,
        thumbnail_path="cover.jpg",
        productLink="https://shop.test/item",
        productTitle="商品标题",
    )

    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert calls[0]["args"] == ()
    assert calls[0]["kwargs"] == {
        "title": "标题",
        "files": ["video.mp4"],
        "tags": ["tag"],
        "account_file": ["account.json"],
        "category": 7,
        "enableTimer": True,
        "videos_per_day": 1,
        "daily_times": [10],
        "start_days": 2,
        "thumbnail_path": "cover.jpg",
        "productLink": "https://shop.test/item",
        "productTitle": "商品标题",
    }


@pytest.mark.parametrize(
    ("platform", "wrapper_name", "original_name"),
    [
        (1, "_inject_declaration_to_xhs", "_ORIGINAL_POST_VIDEO_XHS"),
        (2, "_inject_declaration_to_tencent", "_ORIGINAL_POST_VIDEO_TENCENT"),
        (3, "_inject_declaration_to_douyin", "_ORIGINAL_POST_VIDEO_DOUYIN"),
        (4, "_inject_effective_to_ks", "_ORIGINAL_POST_VIDEO_KS"),
    ],
)
def test_single_and_batch_effective_commands_match_for_all_platforms(
    monkeypatch, platform: int, wrapper_name: str, original_name: str
) -> None:
    """四平台单发与 batch 进入同一命名 timer command seam。"""
    uploader_wrapper.install()
    calls: list[dict[str, Any]] = []

    def fake_official(*args: Any, **kwargs: Any) -> None:
        calls.append({"args": args, "kwargs": kwargs})

    monkeypatch.setattr(uploader_wrapper, original_name, fake_official)
    payload = {
        "title": "标题",
        "fileList": ["video.mp4"],
        "tags": ["tag"],
        "accountList": ["account.json"],
        "type": platform,
        "category": 7,
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": [10],
        "startDays": 2,
        "thumbnail": "cover.jpg",
        "productLink": "https://shop.test/item",
        "productTitle": "商品标题",
        "isDraft": True,
    }
    account = {
        "id": 1,
        "type": platform,
        "filePath": "account.json",
        "userName": "测试账号",
        "status": 1,
        "default_platform_fields": None,
    }
    from posthub.publish_adapter import normalize_publish_payloads

    item = normalize_publish_payloads([payload], [account]).effective[0]
    wrapper = getattr(uploader_wrapper, wrapper_name)
    for _ in ("single", "batch"):
        uploader_wrapper.set_pending_effective_items([item])
        kwargs = {
            "category": 7,
            "enableTimer": True,
            "videos_per_day": 1,
            "daily_times": [10],
            "start_days": 2,
        }
        if platform == 2:
            kwargs["is_draft"] = True
        if platform == 3:
            kwargs.update(
                {
                    "thumbnail_path": "cover.jpg",
                    "productLink": "https://shop.test/item",
                    "productTitle": "商品标题",
                }
            )
        wrapper("标题", ["video.mp4"], ["tag"], ["account.json"], **kwargs)

    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert calls[0]["args"] == ()
    assert calls[0]["kwargs"]["enableTimer"] is True
    assert calls[0]["kwargs"]["videos_per_day"] == 1
    assert calls[0]["kwargs"]["daily_times"] == [10]
    assert calls[0]["kwargs"]["start_days"] == 2
    assert calls[0]["kwargs"]["category"] == 7
    if platform == 2:
        assert calls[0]["kwargs"]["is_draft"] is True
    if platform == 3:
        assert calls[0]["kwargs"]["thumbnail_path"] == "cover.jpg"
        assert calls[0]["kwargs"]["productLink"] == "https://shop.test/item"
        assert calls[0]["kwargs"]["productTitle"] == "商品标题"


@pytest.mark.parametrize(
    ("platform", "class_name", "account_file"),
    [
        (1, "XiaoHongShuVideo", "xhs.json"),
        (2, "TencentVideo", "wechat.json"),
        (3, "DouYinVideo", "douyin.json"),
        (4, "KSVideo", "ks.json"),
    ],
)
def test_timer_http_single_and_batch_use_fake_uploader_contract(
    monkeypatch, tmp_path, platform: int, class_name: str, account_file: str
) -> None:
    """现有 timer HTTP seam 对四平台单发/batch 保持同一 scheduled contract。"""
    app = Flask(__name__)
    app.add_url_rule(
        "/postVideo",
        endpoint="postVideo",
        view_func=sau_backend.postVideo,
        methods=["POST"],
    )
    app.add_url_rule(
        "/postVideoBatch",
        endpoint="postVideoBatch",
        view_func=sau_backend.postVideoBatch,
        methods=["POST"],
    )
    db_path = tmp_path / "db" / "database.db"
    compose_posthub_backend(app, db_path)
    with __import__("sqlite3").connect(db_path) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName, status) VALUES (?, ?, ?, 1)",
            (platform, account_file, "测试账号"),
        )
        conn.commit()

    original_class = getattr(uploader_wrapper, f"_Original{class_name}")
    calls: list[dict[str, Any]] = []

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        publish_date = kwargs.get("publish_date", args[3])
        calls.append(
            {
                "args": args,
                "kwargs": kwargs,
                "publish_date": publish_date,
            }
        )
        self.publish_date = publish_date
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)
    monkeypatch.setattr(original_class, "douyin_upload_video", fake_main, raising=False)

    payload = {
        "fileList": ["video.mp4"],
        "accountList": [account_file],
        "type": platform,
        "title": "timer contract",
        "tags": ["timer"],
        "category": 7,
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": [10],
        "startDays": 1,
        "thumbnail": "cover.jpg",
        "productLink": "https://shop.test/item",
        "productTitle": "商品标题",
        "isDraft": True,
    }

    with app.test_client() as client:
        assert client.post("/postVideo", json=payload).status_code == 200
        assert client.post("/postVideoBatch", json=[payload]).status_code == 200

    assert len(calls) == 2
    assert [call["kwargs"]["publish_strategy"] for call in calls] == [
        "scheduled",
        "scheduled",
    ]
    assert all(isinstance(call["publish_date"], datetime) for call in calls)
    assert all(call["publish_date"].hour == 10 for call in calls)
    if platform == 3:
        assert all(
            call["args"][5:8] == ("cover.jpg", "https://shop.test/item", "商品标题")
            for call in calls
        )
    if platform == 2:
        assert all(call["args"][5:7] == (7, True) for call in calls)
