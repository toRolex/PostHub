"""四平台 scheduled wrapper 的官方上传类契约测试。"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import pytest
from flask import Flask

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
    expected_hour = 11 if platform == 2 and isinstance(daily_times[0], str) else 10
    assert all(call["publish_date"].hour == expected_hour for call in calls)
    expected_minute = (
        0 if platform == 2 else (30 if isinstance(daily_times[0], str) else 0)
    )
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


def test_wechat_wrapper_uses_final_hour_and_cross_day_datetime_snapshot(
    monkeypatch,
) -> None:
    from posthub.publish_adapter import normalize_publish_payloads

    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "视频号跨日",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["23:30"],
        "startDays": 0,
    }
    account = {
        "id": 1,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号",
        "status": 1,
        "default_platform_fields": None,
    }
    item = normalize_publish_payloads(
        [payload],
        [account],
        now=datetime(2026, 8, 27, 12, 0, tzinfo=UTC).replace(tzinfo=None),
    ).effective[0]
    calls: list[dict[str, Any]] = []
    original_class = uploader_wrapper._OriginalTencentVideo

    def fake_init(self, *args: Any, **kwargs: Any) -> None:
        calls.append({"args": args, "kwargs": kwargs})
        self.publish_date = kwargs.get("publish_date", args[3])
        self.publish_strategy = kwargs.get("publish_strategy")

    async def fake_main(self) -> None:
        return None

    monkeypatch.setattr(original_class, "__init__", fake_init)
    monkeypatch.setattr(original_class, "main", fake_main, raising=False)
    uploader_wrapper.set_pending_effective_items([item])
    try:
        uploader_wrapper._inject_declaration_to_tencent(
            "视频号跨日",
            ["video.mp4"],
            [],
            ["wechat.json"],
            enableTimer=True,
            videos_per_day=1,
            daily_times=["00:00"],
            start_days=1,
        )
    finally:
        uploader_wrapper.set_pending_effective_items([])

    assert calls[0]["kwargs"]["publish_strategy"] == "scheduled"
    assert calls[0]["args"][3] == datetime(2026, 8, 29, 0, 0, tzinfo=UTC).replace(
        tzinfo=None
    )


class _XhsStubLocator:
    def __init__(
        self, available: bool, *, click_error: Exception | None = None
    ) -> None:
        self.available = available
        self.click_error = click_error
        self.clicks = 0
        self.wait_calls = 0

    @property
    def first(self):
        return self

    async def wait_for(self, *, state: str, timeout: float) -> None:
        assert state == "visible"
        assert timeout > 0
        self.wait_calls += 1
        if not self.available:
            raise TimeoutError("not rendered")

    async def count(self) -> int:
        return int(self.available)

    async def is_visible(self) -> bool:
        return self.available

    async def click(self) -> None:
        if self.click_error:
            raise self.click_error
        self.clicks += 1


class _XhsStubPage:
    def __init__(self, locators: dict[str, _XhsStubLocator]) -> None:
        self.locators = locators
        self.requested: list[str] = []
        self.screenshots: list[str] = []

    def locator(self, selector: str) -> _XhsStubLocator:
        self.requested.append(selector)
        return self.locators.get(selector, _XhsStubLocator(False))

    async def screenshot(self, *, path: str, full_page: bool = False) -> None:
        assert full_page
        self.screenshots.append(path)


def test_xhs_source_dom_success_and_wait(monkeypatch) -> None:
    source = "笔记含AI合成内容"
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    option = uploader_wrapper.XHS_SOURCE_OPTION_SELECTOR.format(source=source)
    page = _XhsStubPage(
        {
            entry: _XhsStubLocator(False),
            option: _XhsStubLocator(False),
        }
    )
    page.locators[entry].available = True
    page.locators[option].available = True

    result = asyncio.run(uploader_wrapper._apply_xhs_source_declaration(page, source))

    assert result.status == "applied"
    assert page.locators[entry].clicks == 1
    assert page.locators[option].clicks == 1
    assert page.screenshots == []


def test_xhs_source_missing_or_changed_is_diagnosed() -> None:
    source = "笔记含AI合成内容"
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    page = _XhsStubPage({entry: _XhsStubLocator(True)})

    result = asyncio.run(uploader_wrapper._apply_xhs_source_declaration(page, source))

    assert result.status == "warning"
    assert result.reason == "option_selectors_missed"
    assert result.warning
    assert len(page.screenshots) == 1


def test_xhs_source_click_failure_is_fail_closed_with_screenshot() -> None:
    entry = uploader_wrapper.XHS_SOURCE_ENTRY_SELECTORS[0]
    page = _XhsStubPage(
        {entry: _XhsStubLocator(True, click_error=TimeoutError("detached"))}
    )

    result = asyncio.run(
        uploader_wrapper._apply_xhs_source_declaration(page, "笔记含AI合成内容")
    )

    assert result.status == "warning"
    assert result.reason == "dom_operation_failed"
    assert len(page.screenshots) == 1


def test_xhs_class_hook_blocks_original_when_source_fails(monkeypatch) -> None:
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
        pytest.raises(uploader_wrapper.WrapperExecutionError, match="入口未渲染"),
    ):
        asyncio.run(video.check_original_declaration(_XhsStubPage({})))
