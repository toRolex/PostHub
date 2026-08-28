"""四平台 scheduled wrapper 的官方上传类契约测试。"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import pytest
from flask import Flask
from patchright.async_api import TimeoutError as PatchrightTimeoutError

import sau_backend
from posthub import uploader_wrapper
from posthub.composition import compose_posthub_backend


@pytest.mark.parametrize(
    ("wrapper_name", "class_name", "extra"),
    [
        ("_inject_declaration_to_xhs", "XiaoHongShuVideo", {}),
        ("_inject_declaration_to_tencent", "TencentVideo", {"is_draft": True}),
        ("_inject_declaration_to_douyin", "DouYinVideo", {}),
        ("_inject_effective_to_ks", "KSVideo", {}),
    ],
)
def test_immediate_wrappers_explicitly_pass_immediate_strategy(
    monkeypatch, wrapper_name: str, class_name: str, extra: dict[str, Any]
) -> None:
    """立即路径也必须显式传 immediate，不得被日期适配误标 scheduled。"""
    uploader_wrapper.install()
    original_class = getattr(uploader_wrapper, f"_Original{class_name}")
    calls: list[dict[str, Any]] = []

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        calls.append(
            {
                "publish_date": args[3],
                "publish_strategy": kwargs.get("publish_strategy"),
            }
        )
        self.publish_date = args[3]
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)
    monkeypatch.setattr(original_class, "douyin_upload_video", fake_main, raising=False)

    uploader_wrapper.set_pending_effective_items([])
    uploader_wrapper.set_pending_declarations([])
    getattr(uploader_wrapper, wrapper_name)(
        "标题",
        ["video.mp4"],
        ["tag"],
        ["account.json"],
        category=7,
        enableTimer=False,
        videos_per_day=1,
        daily_times=[10],
        start_days=2,
        **extra,
    )

    assert calls == [{"publish_date": 0, "publish_strategy": "immediate"}]


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
        dates.append((args[3], args[4]))
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
        ["first.json", "second.json"],
        category=7,
        enableTimer=True,
        videos_per_day=2,
        daily_times=[8, 10],
        start_days=1,
    )

    assert [(value.hour, account.name) for value, account in dates] == [
        (8, "first.json"),
        (8, "second.json"),
        (10, "first.json"),
        (10, "second.json"),
    ]


def test_xhs_scheduled_wrapper_rejects_short_date_list() -> None:
    """日期数量不足时不得静默复用最后一项日期。"""
    with (
        uploader_wrapper._xhs_file_context(
            ["first.mp4", "second.mp4"], ["account.json"]
        ),
        pytest.raises(ValueError, match="少于素材"),
    ):
        uploader_wrapper._XiaoHongShuVideoWithStrategy(
            "标题",
            "first.mp4",
            [],
            [datetime(2030, 1, 1, 10, tzinfo=UTC)],
            "account.json",
        )


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


def test_schedule_adapter_supports_hhmm_minutes_without_rounding() -> None:
    result = uploader_wrapper._generate_schedule_with_start_days(
        1, 1, ["10:30"], timestamps=False, start_days=0
    )

    assert len(result) == 1
    assert result[0].hour == 10
    assert result[0].minute == 30
    assert result[0].second == 0
    assert result[0].microsecond == 0


def test_schedule_adapter_converts_all_hhmm_slots_and_preserves_start_days(
    monkeypatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_generate(
        total_videos: int,
        *,
        videos_per_day: int,
        daily_times: list[int | float],
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
        return []

    monkeypatch.setattr(
        uploader_wrapper, "_ORIGINAL_GENERATE_SCHEDULE_TIME", fake_generate
    )
    uploader_wrapper._generate_schedule_with_start_days(
        2, 2, ["10:30", "11:45"], timestamps=False, start_days=2
    )

    assert captured == {
        "total_videos": 2,
        "videos_per_day": 2,
        "daily_times": [10.5, 11.75],
        "timestamps": False,
        "start_days": 2,
    }


@pytest.mark.parametrize("daily_times", ([24], [-1], [1.5], [True], ["24:00"]))
def test_schedule_adapter_rejects_invalid_daily_times(daily_times: list[Any]) -> None:
    with pytest.raises((TypeError, ValueError), match="daily_times"):
        uploader_wrapper._generate_schedule_with_start_days(
            1, 1, daily_times, timestamps=False, start_days=0
        )


@pytest.mark.parametrize("daily_times", (10, "10:30"))
def test_schedule_adapter_rejects_non_array_daily_times(daily_times: Any) -> None:
    with pytest.raises(TypeError, match="daily_times"):
        uploader_wrapper._generate_schedule_with_start_days(
            1, 1, daily_times, timestamps=False, start_days=0
        )


@pytest.mark.parametrize("start_days", [-1, 1.5, "2", True])
def test_schedule_adapter_rejects_invalid_start_days(start_days: Any) -> None:
    with pytest.raises((TypeError, ValueError), match="start_days"):
        uploader_wrapper._generate_schedule_with_start_days(
            1, 1, ["10:00"], timestamps=False, start_days=start_days
        )


def test_douyin_batch_legacy_tail_is_realigned() -> None:
    app = Flask(__name__)
    app.add_url_rule("/postVideoBatch", endpoint="postVideoBatch", view_func=lambda: "")
    app.add_url_rule("/postVideo", endpoint="postVideo", view_func=lambda: "")
    with app.test_request_context("/postVideoBatch"):
        assert uploader_wrapper._normalize_douyin_tail(
            "product-link", "product-title", ""
        ) == ("", "product-link", "product-title")
    with app.test_request_context("/postVideo"):
        assert uploader_wrapper._normalize_douyin_tail(
            "cover.jpg", "product-link", "product-title"
        ) == ("cover.jpg", "product-link", "product-title")


def test_schedule_adapter_preserves_boolean_timestamps(monkeypatch) -> None:
    captured: list[tuple[bool, int]] = []

    def fake_generate(
        total_videos: int,
        *,
        videos_per_day: int,
        daily_times: list[int],
        timestamps: bool,
        start_days: int,
    ) -> list[datetime]:
        captured.append((timestamps, start_days))
        return []

    monkeypatch.setattr(
        uploader_wrapper, "_ORIGINAL_GENERATE_SCHEDULE_TIME", fake_generate
    )
    uploader_wrapper._generate_schedule_with_start_days(
        1, 1, [10], timestamps=False, start_days=2
    )
    uploader_wrapper._generate_schedule_with_start_days(
        1, 1, [10], timestamps=True, start_days=2
    )

    assert captured == [(False, 2), (True, 2)]


def test_schedule_adapter_rejects_non_boolean_timestamp_slot() -> None:
    """HH:MM 等误落 timestamps 位置时不得静默当成 startDays。"""
    with pytest.raises(TypeError, match="timestamps"):
        uploader_wrapper._generate_schedule_with_start_days(
            1, 1, [10], timestamps="10:30"
        )


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
        "daily_times": ["10:00"],
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
    assert calls[0]["kwargs"]["daily_times"] == ["10:00"]
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
@pytest.mark.parametrize("daily_times", ([10], ["10:30"]))
def test_timer_http_single_and_batch_use_fake_uploader_contract(
    monkeypatch,
    tmp_path,
    platform: int,
    class_name: str,
    account_file: str,
    daily_times: list[int] | list[str],
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
        "dailyTimes": daily_times,
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
    expected_minute = 30 if isinstance(daily_times[0], str) else 0
    assert all(call["publish_date"].minute == expected_minute for call in calls)
    if platform == 3:
        assert all(
            call["args"][5:8] == ("cover.jpg", "https://shop.test/item", "商品标题")
            for call in calls
        )
    if platform == 2:
        assert all(call["args"][5:7] == (7, True) for call in calls)


def test_douyin_wrapper_reuses_effective_absolute_datetime_snapshot(
    monkeypatch,
) -> None:
    """fake uploader 必须收到 normalization 时冻结的本地 naive 时刻。"""
    from posthub.publish_adapter import normalize_publish_payloads

    uploader_wrapper.install()
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["account.json"],
        "type": 3,
        "title": "分钟",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["14:37"],
        "startDays": 1,
    }
    account = {
        "id": 1,
        "type": 3,
        "filePath": "account.json",
        "userName": "抖音",
        "status": 1,
        "default_platform_fields": None,
    }
    item = normalize_publish_payloads(
        [payload],
        [account],
        now=datetime(2026, 8, 27, 23, 50, tzinfo=UTC).replace(tzinfo=None),
    ).effective[0]
    calls: list[datetime] = []
    original_class = uploader_wrapper._OriginalDouYinVideo

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        calls.append(kwargs.get("publish_date", args[3]))
        self.publish_date = calls[-1]
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_upload(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(
        original_class, "douyin_upload_video", fake_upload, raising=False
    )
    uploader_wrapper.set_pending_effective_items([item])
    try:
        uploader_wrapper._inject_declaration_to_douyin(
            "分钟",
            ["video.mp4"],
            [],
            ["account.json"],
            enableTimer=True,
            videos_per_day=1,
            daily_times=["14:37"],
            start_days=1,
        )
    finally:
        uploader_wrapper.set_pending_effective_items([])

    assert calls == [datetime(2026, 8, 29, 14, 37, tzinfo=UTC).replace(tzinfo=None)]
    assert calls[0].tzinfo is None


def test_run_detail_keeps_submitted_and_effective_timer_snapshots(tmp_path) -> None:
    """run detail 与 fake uploader 使用同一份 persisted effective 快照。"""
    from posthub.publish_adapter import normalize_publish_payloads
    from posthub.runs import RunStore

    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["account.json"],
        "type": 3,
        "title": "分钟",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["14:37"],
        "startDays": 1,
    }
    account = {
        "id": 1,
        "type": 3,
        "filePath": "account.json",
        "userName": "抖音",
        "status": 1,
        "default_platform_fields": None,
    }
    normalized = normalize_publish_payloads(
        [payload],
        [account],
        now=datetime(2026, 8, 27, 23, 50, tzinfo=UTC).replace(tzinfo=None),
    )
    detail = RunStore(tmp_path / "runs.db")
    run_id = detail.create_run(normalized.effective)

    item = detail.get_run(run_id)["items"][0]
    assert item["submitted"] == payload
    assert item["effective"]["dailyTimes"] == ["14:37"]
    assert item["effective"]["publishDatetimes"] == ["2026-08-29T14:37:00"]


class _StubLocator:
    def __init__(
        self,
        *,
        available: bool,
        visible: bool = True,
        appears_on_wait: bool = False,
    ) -> None:
        self.available = available
        self.visible = visible
        self.appears_on_wait = appears_on_wait
        self.wait_calls = 0
        self.clicks = 0

    async def wait_for(self, *, state: str, timeout: float) -> None:
        assert state == "visible"
        assert timeout > 0
        self.wait_calls += 1
        if self.appears_on_wait or (self.available and self.visible):
            self.available = True
            self.visible = True
            return
        raise TimeoutError("stub locator did not render")

    @property
    def first(self):
        return self

    async def count(self) -> int:
        return 1 if self.available else 0

    async def is_visible(self) -> bool:
        return self.visible

    async def click(self) -> None:
        self.clicks += 1


class _XhsSourceStubPage:
    def __init__(self, locators: dict[str, _StubLocator]) -> None:
        self.locators = locators
        self.requested: list[str] = []
        self.screenshot_paths: list[str] = []

    def locator(self, selector: str) -> _StubLocator:
        self.requested.append(selector)
        return self.locators.get(selector, _StubLocator(available=False))

    async def screenshot(self, *, path: str, full_page: bool = False) -> None:
        assert full_page is True
        self.screenshot_paths.append(path)


def test_xhs_ai_synthesized_source_stub_applies_and_returns_applied_result() -> None:
    source = "笔记含AI合成内容"
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    exact = uploader_wrapper.XHS_SOURCE_OPTION_SELECTOR.format(source=source)
    page = _XhsSourceStubPage(
        {
            entry: _StubLocator(available=True),
            exact: _StubLocator(available=True),
        }
    )

    result = asyncio.run(uploader_wrapper._apply_xhs_source_declaration(page, source))

    assert result.status == "applied"
    assert result.reason is None
    assert page.locators[entry].clicks == 1
    assert page.locators[exact].clicks == 1
    assert page.screenshot_paths == []


def test_xhs_source_waits_for_entry_and_option_to_render() -> None:
    source = "笔记含AI合成内容"
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    exact = uploader_wrapper.XHS_SOURCE_OPTION_SELECTOR.format(source=source)
    entry_locator = _StubLocator(available=False, appears_on_wait=True)
    option_locator = _StubLocator(available=False, appears_on_wait=True)
    page = _XhsSourceStubPage({entry: entry_locator, exact: option_locator})

    result = asyncio.run(uploader_wrapper._apply_xhs_source_declaration(page, source))

    assert result.status == "applied"
    assert entry_locator.wait_calls == 1
    assert option_locator.wait_calls == 1


class _PatchrightTimeoutLocator:
    @property
    def first(self):
        return self

    async def wait_for(self, *, state: str, timeout: float) -> None:
        raise PatchrightTimeoutError("patchright timeout")

    async def count(self) -> int:
        return 0

    async def is_visible(self) -> bool:
        return False


class _PatchrightTimeoutPage:
    def __init__(self) -> None:
        self.screenshot_paths: list[str] = []

    def locator(self, _selector: str) -> _PatchrightTimeoutLocator:
        return _PatchrightTimeoutLocator()

    async def screenshot(self, *, path: str, full_page: bool = False) -> None:
        assert full_page is True
        self.screenshot_paths.append(path)


def test_xhs_source_catches_patchright_timeout_as_entry_warning() -> None:
    page = _PatchrightTimeoutPage()

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "entry_missing"
    assert len(page.screenshot_paths) == 1


def test_xhs_source_entry_missing_returns_explicit_warning_and_debug_screenshot() -> (
    None
):
    page = _XhsSourceStubPage({})

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "entry_missing"
    assert result.warning
    assert len(page.screenshot_paths) == 1
    assert set(uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS) <= set(page.requested)


def test_xhs_source_candidate_change_returns_explicit_warning() -> None:
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    page = _XhsSourceStubPage(
        {
            entry: _StubLocator(available=True),
            # 页面仍有候选区域，但线上文案已变化。
            uploader_wrapper.XHS_SOURCE_CANDIDATE_SELECTOR: _StubLocator(
                available=True
            ),
        }
    )

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "candidate_missing"
    assert "候选" in result.warning
    assert len(page.screenshot_paths) == 1


def test_xhs_source_double_option_selectors_missed_returns_explicit_result() -> None:
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    page = _XhsSourceStubPage({entry: _StubLocator(available=True)})

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "option_selectors_missed"
    expected_selectors = {
        selector.format(source="笔记含AI合成内容")
        for selector in uploader_wrapper.XHS_SOURCE_OPTION_SELECTORS
    }
    assert expected_selectors <= set(page.requested)
    assert len(page.screenshot_paths) == 1


class _ClickFailureLocator(_StubLocator):
    async def click(self) -> None:
        raise TimeoutError("element detached")


def test_xhs_source_click_failure_returns_warning_and_debug_screenshot() -> None:
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    page = _XhsSourceStubPage({entry: _ClickFailureLocator(available=True)})

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "dom_operation_failed"
    assert "DOM 操作失败" in result.warning
    assert len(page.screenshot_paths) == 1


def test_xhs_class_hook_fails_closed_when_source_is_not_applied(monkeypatch) -> None:
    async def unexpected_original_check(self: Any, _page: Any) -> None:
        raise AssertionError("source failure must block original declaration flow")

    monkeypatch.setattr(
        uploader_wrapper._OriginalXiaoHongShuVideo,
        "check_original_declaration",
        unexpected_original_check,
    )
    video = object.__new__(uploader_wrapper._XiaoHongShuVideoWithStrategy)
    with (
        uploader_wrapper._declaration_context(
            {"platform": 1, "fields": {"source": "笔记含AI合成内容"}}
        ),
        pytest.raises(RuntimeError, match="入口未渲染"),
    ):
        asyncio.run(video.check_original_declaration(_XhsSourceStubPage({})))


@pytest.mark.parametrize("endpoint", ("postVideo", "postVideoBatch"))
def test_xhs_legacy_http_route_fails_closed_when_source_is_not_applied(
    monkeypatch, tmp_path, endpoint: str
) -> None:
    """旧单发/batch seam 不得把 source warning 返回成 200 成功。"""
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
            "INSERT INTO user_info (type, filePath, userName, status) VALUES (1, ?, ?, 1)",
            ("xhs.json", "小红书测试账号"),
        )
        conn.commit()

    def fake_official(**_kwargs: Any) -> None:
        video = object.__new__(uploader_wrapper._XiaoHongShuVideoWithStrategy)
        asyncio.run(video.check_original_declaration(_XhsSourceStubPage({})))

    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_XHS", fake_official)
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["xhs.json"],
        "type": 1,
        "title": "小红书声明",
        "tags": [],
        "platformFields": {"xiaohongshu": {"source": "ai_synthesized"}},
    }

    request_payload = [payload] if endpoint == "postVideoBatch" else payload
    with app.test_client() as client:
        response = client.post(f"/{endpoint}", json=request_payload)

    assert response.status_code == 500
    body = response.get_json()
    assert body["code"] == 500
    assert "入口未渲染" in body["msg"]
    assert body["diagnostics"]["warnings"] == [
        "小红书内容声明入口未渲染，未能应用 source"
    ]
    assert len(body["diagnostics"]["debugScreenshots"]) == 1


def test_xhs_class_hook_applies_source_without_touching_wechat_selector(
    monkeypatch,
) -> None:
    source = "笔记含AI合成内容"
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    exact = uploader_wrapper.XHS_SOURCE_OPTION_SELECTOR.format(source=source)
    page = _XhsSourceStubPage(
        {
            entry: _StubLocator(available=True),
            exact: _StubLocator(available=True),
        }
    )

    async def fake_original_check(self: Any, _page: Any) -> None:
        return None

    monkeypatch.setattr(
        uploader_wrapper._OriginalXiaoHongShuVideo,
        "check_original_declaration",
        fake_original_check,
    )
    video = object.__new__(uploader_wrapper._XiaoHongShuVideoWithStrategy)
    with uploader_wrapper._declaration_context(
        {"platform": 1, "fields": {"source": source}}
    ):
        asyncio.run(video.check_original_declaration(page))
        diagnostics = uploader_wrapper.consume_diagnostics()

    assert diagnostics == {"warnings": [], "debugScreenshots": []}
    assert page.locators[exact].clicks == 1
    assert 'text="内容声明"' not in page.requested


def test_xhs_direct_wrapper_returns_dom_diagnostics_after_context_cleanup(
    monkeypatch,
) -> None:
    """非 HTTP 兼容入口也必须把 wrapper 诊断交给调用方。"""
    page = _XhsSourceStubPage({})
    source = "笔记含AI合成内容"

    async def fake_original_check(self: Any, _page: Any) -> None:
        return None

    def fake_official(**_kwargs: Any) -> None:
        video = object.__new__(uploader_wrapper._XiaoHongShuVideoWithStrategy)
        asyncio.run(video.check_original_declaration(page))

    monkeypatch.setattr(
        uploader_wrapper._OriginalXiaoHongShuVideo,
        "check_original_declaration",
        fake_original_check,
    )
    monkeypatch.setattr(uploader_wrapper, "_ORIGINAL_POST_VIDEO_XHS", fake_official)
    uploader_wrapper.set_pending_effective_items([])
    uploader_wrapper.set_pending_declarations(
        [{"platform": 1, "fields": {"source": source}}]
    )
    try:
        with pytest.raises(uploader_wrapper.WrapperExecutionError) as raised:
            uploader_wrapper._inject_declaration_to_xhs(
                "标题", ["video.mp4"], [], ["account.json"]
            )
    finally:
        uploader_wrapper.set_pending_declarations([])

    diagnostics = raised.value.diagnostics
    assert diagnostics["warnings"] == ["小红书内容声明入口未渲染，未能应用 source"]
    assert len(diagnostics["debugScreenshots"]) == 1
