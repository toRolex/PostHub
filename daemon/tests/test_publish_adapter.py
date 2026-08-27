"""EffectiveBatchItem normalization 与发布执行 adapter 契约测试。"""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import pytest
from flask import Flask

from posthub import uploader_wrapper
from posthub.publish_adapter import (
    AccountSnapshot,
    NormalizationError,
    PublishExecutionAdapter,
    normalize_publish_payloads,
)

ACCOUNT_FIXTURES = [
    {
        "id": 11,
        "type": 1,
        "filePath": "xhs.json",
        "userName": "小红书账号",
        "status": 1,
        "default_platform_fields": None,
    },
    {
        "id": 12,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号账号",
        "status": 1,
        "default_platform_fields": {"wechat": {"declaration": "no_label"}},
    },
    {
        "id": 13,
        "type": 3,
        "filePath": "douyin.json",
        "userName": "抖音账号",
        "status": 1,
        "default_platform_fields": {"douyin": {"declaration": "no_need"}},
    },
    {
        "id": 14,
        "type": 4,
        "filePath": "kuaishou.json",
        "userName": "快手账号",
        "status": 1,
        "default_platform_fields": None,
    },
]


@pytest.mark.parametrize(
    ("daily_times", "expected"),
    [
        ([10, 14], ["10:00", "14:00"]),
        (["14:30", "09:05", "14:30"], ["09:05", "14:30"]),
    ],
)
def test_schedule_daily_times_is_double_read_single_write(
    daily_times: list[int] | list[str], expected: list[str]
) -> None:
    payload = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "定时",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": daily_times,
        "startDays": 2,
    }

    result = normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    assert result.submitted[0]["dailyTimes"] == daily_times
    assert result.effective[0].effective["dailyTimes"] == expected


@pytest.mark.parametrize(
    ("payload", "expected_type", "expected_fields"),
    [
        (
            {
                "fileList": ["xhs.mp4"],
                "accountList": ["xhs.json"],
                "type": 1,
                "title": "小红书",
                "tags": ["旅行"],
                "category": 7,
                "thumbnail": "cover-xhs.jpg",
                "productLink": "https://shop.test/xhs",
                "productTitle": "小红书商品",
                "isDraft": True,
                "enableTimer": False,
            },
            1,
            None,
        ),
        (
            {
                "fileList": ["wechat.mp4"],
                "accountList": ["wechat.json"],
                "type": 2,
                "title": "视频号",
                "tags": [],
                "category": 3,
                "enableTimer": True,
                "videosPerDay": 1,
                "dailyTimes": [10, 14],
                "startDays": 2,
                "isDraft": True,
                "platformFields": {"wechat": {"declaration": "marketing"}},
            },
            2,
            {"wechat": {"declaration": "marketing"}},
        ),
        (
            {
                "fileList": ["douyin.mp4"],
                "accountList": ["douyin.json"],
                "type": 3,
                "title": "抖音",
                "tags": ["探店"],
                "category": 5,
                "thumbnail": "cover-dy.jpg",
                "productLink": "https://shop.test/dy",
                "productTitle": "抖音商品",
                "isDraft": False,
                "enableTimer": False,
                "platformFields": {"douyin": {"declaration": "marketing"}},
            },
            3,
            {"douyin": {"declaration": "marketing"}},
        ),
        (
            {
                "fileList": ["kuaishou.mp4"],
                "accountList": ["kuaishou.json"],
                "type": 4,
                "title": "快手",
                "tags": [],
                "category": 1,
                "enableTimer": True,
                "videosPerDay": 1,
                "dailyTimes": [20],
                "startDays": 0,
                "thumbnail": "cover-ks.jpg",
                "productLink": "https://shop.test/ks",
                "productTitle": "快手商品",
                "isDraft": True,
            },
            4,
            None,
        ),
    ],
)
def test_normalization_preserves_official_platform_payload_fields(
    payload: dict[str, Any], expected_type: int, expected_fields: dict[str, Any] | None
) -> None:
    result = normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    assert len(result.submitted) == 1
    assert len(result.effective) == 1
    item = result.effective[0]
    assert item.platform_type == expected_type
    assert item.effective["fileList"] == payload["fileList"]
    assert item.effective["accountList"] == payload["accountList"]
    assert item.effective["category"] == payload["category"]
    assert item.effective.get("platformFields") == expected_fields
    if payload.get("enableTimer"):
        assert item.effective["dailyTimes"] == [
            f"{hour:02d}:00" for hour in sorted(set(payload["dailyTimes"]))
        ]
    for field in ("thumbnail", "productLink", "productTitle", "isDraft"):
        if field in payload:
            assert item.effective[field] == payload[field]


def test_schedule_accepts_hhmm_and_effective_payload_preserves_minutes() -> None:
    payload = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "定时",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 2,
        "dailyTimes": ["14:30", "09:05", "14:30"],
        "startDays": 2,
    }

    result = normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    assert result.submitted[0]["dailyTimes"] == ["14:30", "09:05", "14:30"]
    assert result.effective[0].effective["dailyTimes"] == ["09:05", "14:30"]
    assert all(
        isinstance(value, str) for value in result.effective[0].effective["dailyTimes"]
    )


def test_normalization_splits_accounts_and_emits_submitted_and_effective_snapshots() -> (
    None
):
    payload = {
        "fileList": ["same.mp4"],
        "accountList": ["dy-a.json", "dy-b.json"],
        "type": 3,
        "title": "双账号",
        "tags": [],
        "enableTimer": False,
    }
    accounts = [
        {
            "id": 31,
            "type": 3,
            "filePath": "dy-a.json",
            "userName": "A",
            "status": 1,
            "default_platform_fields": {"douyin": {"declaration": "no_need"}},
        },
        {
            "id": 32,
            "type": 3,
            "filePath": "dy-b.json",
            "userName": "B",
            "status": 1,
            "default_platform_fields": {"douyin": {"declaration": "personal_opinion"}},
        },
    ]

    result = normalize_publish_payloads([payload], accounts)

    assert result.submitted == (payload,)
    assert result.submitted[0] is not payload
    assert [item.effective["accountList"] for item in result.effective] == [
        ["dy-a.json"],
        ["dy-b.json"],
    ]
    assert [item.effective["platformFields"] for item in result.effective] == [
        {"douyin": {"declaration": "no_need"}},
        {"douyin": {"declaration": "personal_opinion"}},
    ]
    assert [item.account_snapshot.account_id for item in result.effective] == [31, 32]

    payload["title"] = "调用方后续修改不应污染 submitted 快照"
    assert result.submitted[0]["title"] == "双账号"


def test_task_platform_fields_override_account_defaults() -> None:
    payload = {
        "fileList": ["wechat.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "覆盖声明原创",
        "tags": [],
        "enableTimer": False,
        "platformFields": {"wechat": {"declaration": "marketing"}},
    }

    result = normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    assert result.effective[0].effective["platformFields"] == {
        "wechat": {"declaration": "marketing"}
    }
    assert result.effective[0].account_snapshot.default_platform_fields == {
        "wechat": {"declaration": "no_label"}
    }


def test_normalization_canonicalizes_legacy_platform_fields_and_official_category_zero() -> (
    None
):
    payload = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "兼容旧键",
        "tags": [],
        "category": 0,
        "platform_fields": {"douyin": {"declaration": "marketing"}},
    }

    command = (
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES).effective[0].effective
    )

    assert command["category"] is None
    assert "platform_fields" not in command
    assert command["platformFields"] == {"douyin": {"declaration": "marketing"}}


def test_normalization_rejects_invalid_platform_malformed_item_and_empty_inputs() -> (
    None
):
    valid = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "标题",
        "tags": [],
    }
    cases = [
        ({**valid, "type": 99}, "平台"),
        ([], "item"),
        ({**valid, "fileList": []}, "素材"),
        ({**valid, "accountList": []}, "账号"),
        ({**valid, "accountList": ["missing.json"]}, "账号快照"),
        ({**valid, "title": ""}, "标题"),
    ]
    for payload, expected in cases:
        with pytest.raises(NormalizationError, match=expected):
            normalize_publish_payloads([payload], ACCOUNT_FIXTURES)


def test_normalization_rejects_invalid_schedule_and_platform_field_shape() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "标题",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 2,
        "dailyTimes": [10],
        "startDays": 0,
        "platformFields": {"douyin": {"declaration": "no_need"}},
    }
    with pytest.raises(NormalizationError, match="每日条数"):
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    payload["videosPerDay"] = 1
    payload["platformFields"] = {"douyin": {"origin": True}}
    with pytest.raises(NormalizationError, match="字段非法"):
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    for invalid_time in ("24:00", "12:60", "bad"):
        invalid_schedule = {
            **payload,
            "platformFields": None,
            "dailyTimes": [invalid_time],
        }
        with pytest.raises(NormalizationError, match="每日时刻"):
            normalize_publish_payloads([invalid_schedule], ACCOUNT_FIXTURES)


@pytest.mark.parametrize("malformed_type", [[], {}, 3.0])
def test_normalization_wraps_malformed_platform_types(
    malformed_type: Any,
) -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": malformed_type,
        "title": "标题",
        "tags": [],
    }

    with pytest.raises(NormalizationError, match="平台类型非法"):
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES)


@pytest.mark.parametrize(
    ("platform_fields", "expected"),
    [
        ({"douyin": {"declaration": []}}, "declaration"),
        ({"wechat": {"origin": "yes"}}, "origin"),
        ({"xiaohongshu": {"source": {}}}, "source"),
    ],
)
def test_normalization_rejects_malformed_platform_field_values(
    platform_fields: dict[str, Any], expected: str
) -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "标题",
        "tags": [],
        "platformFields": platform_fields,
    }

    with pytest.raises(NormalizationError, match=expected):
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES)


@pytest.mark.parametrize(
    ("platform_type", "platform_fields", "expected_field"),
    [
        (1, {"xiaohongshu": {"source": "self_declare"}}, "source"),
        (1, {"xiaohongshu": {"origin": True}}, "origin"),
        (2, {"wechat": {"origin": False}}, "origin"),
    ],
)
def test_normalization_rejects_fields_without_a_safe_execution_seam(
    platform_type: int,
    platform_fields: dict[str, Any],
    expected_field: str,
) -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": [{1: "xhs.json", 2: "wechat.json"}[platform_type]],
        "type": platform_type,
        "title": "声明执行边界",
        "tags": [],
        "platformFields": platform_fields,
    }

    with pytest.raises(NormalizationError, match=expected_field):
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES)


def test_normalization_omits_null_account_default_fields() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "空默认字段",
        "tags": [],
    }
    accounts = deepcopy(ACCOUNT_FIXTURES)
    accounts[2]["default_platform_fields"] = {"douyin": {"declaration": None}}

    command = normalize_publish_payloads([payload], accounts).effective[0].effective

    assert "platformFields" not in command


def test_normalization_rejects_unsupported_account_default_before_execution() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["xhs.json"],
        "type": 1,
        "title": "账号默认声明执行边界",
        "tags": [],
    }
    accounts = deepcopy(ACCOUNT_FIXTURES)
    accounts[0]["default_platform_fields"] = {"xiaohongshu": {"source": "self_declare"}}

    with pytest.raises(NormalizationError, match="source"):
        normalize_publish_payloads([payload], accounts)


def test_execution_adapter_normalizes_before_invoking_official_seam() -> None:
    calls: list[dict[str, Any]] = []

    def invoke(command: dict[str, Any]) -> None:
        calls.append(command)

    adapter = PublishExecutionAdapter(invoke)
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "标题",
        "tags": [],
    }

    normalized = adapter.execute([payload], ACCOUNT_FIXTURES)
    assert len(calls) == 1
    assert calls[0] == normalized.effective[0].effective

    calls.clear()
    with pytest.raises(NormalizationError):
        adapter.execute(
            [payload, {**payload, "fileList": []}],
            ACCOUNT_FIXTURES,
        )
    assert calls == []

    unsupported = {
        "fileList": ["video.mp4"],
        "accountList": ["xhs.json"],
        "type": 1,
        "title": "未支持声明",
        "tags": [],
        "platformFields": {"xiaohongshu": {"source": "self_declare"}},
    }
    with pytest.raises(NormalizationError, match="source"):
        adapter.execute([unsupported], ACCOUNT_FIXTURES)
    assert calls == []


def test_single_and_legacy_batch_payloads_share_the_same_effective_command() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "同一输入",
        "tags": ["tag"],
        "category": 2,
        "thumbnail": "cover.jpg",
        "productLink": "https://shop.test/item",
        "productTitle": "商品",
        "isDraft": True,
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": [10],
        "startDays": 1,
    }

    single = normalize_publish_payloads([deepcopy(payload)], ACCOUNT_FIXTURES)
    legacy_batch = normalize_publish_payloads([deepcopy(payload)], ACCOUNT_FIXTURES)

    assert single.effective[0].effective == legacy_batch.effective[0].effective
    assert (
        single.effective[0].account_snapshot
        == legacy_batch.effective[0].account_snapshot
    )


def test_account_snapshot_is_a_stable_value_object() -> None:
    result = normalize_publish_payloads(
        [
            {
                "fileList": ["video.mp4"],
                "accountList": ["douyin.json"],
                "type": 3,
                "title": "快照",
                "tags": [],
            }
        ],
        ACCOUNT_FIXTURES,
    )
    snapshot = result.effective[0].account_snapshot
    assert isinstance(snapshot, AccountSnapshot)
    assert snapshot.account_id == 13
    assert snapshot.file_path == "douyin.json"
    assert snapshot.platform_type == 3
    assert snapshot.default_platform_fields == {"douyin": {"declaration": "no_need"}}


def test_normalization_ignores_unrelated_malformed_account_rows() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["target.json"],
        "type": 3,
        "title": "只命中目标账号",
        "tags": [],
    }
    accounts = [
        {
            "id": 41,
            "type": 3,
            "filePath": "target.json",
            "userName": "目标账号",
            "status": 1,
            "default_platform_fields": None,
        },
        {
            "id": 42,
            "type": 3,
            "filePath": "unrelated.json",
            "userName": "无关账号",
            "status": 1,
            "default_platform_fields": "不是合法 JSON",
        },
    ]

    result = normalize_publish_payloads([payload], accounts)

    assert [item.account_snapshot.file_path for item in result.effective] == [
        "target.json"
    ]


def test_normalization_revalidates_account_snapshot_value_objects() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "校验值对象",
        "tags": [],
    }
    malformed_snapshot = AccountSnapshot(
        account_id=True,
        platform_type=3,
        file_path="douyin.json",
        user_name="账号",
        status=1,
        default_platform_fields={},
    )

    with pytest.raises(NormalizationError, match="账号快照缺少合法 id"):
        normalize_publish_payloads([payload], [malformed_snapshot])


def test_declaration_producer_emits_canonical_platform_and_fields_shape() -> None:
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "canonical 声明",
        "tags": [],
        "platformFields": {"douyin": {"declaration": "no_need"}},
    }
    item = normalize_publish_payloads([payload], ACCOUNT_FIXTURES).effective[0]

    assert uploader_wrapper._declaration_item_for_effective(item) == {
        "platform": 3,
        "fields": {"declaration": "无需添加自主声明"},
    }


def test_declaration_producer_keeps_empty_fields_canonical_without_declaration() -> (
    None
):
    payload = {
        "fileList": ["video.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "无声明",
        "tags": [],
    }
    accounts = deepcopy(ACCOUNT_FIXTURES)
    accounts[2]["default_platform_fields"] = None
    item = normalize_publish_payloads([payload], accounts).effective[0]

    assert uploader_wrapper._declaration_item_for_effective(item) == {
        "platform": 3,
        "fields": {},
    }


@pytest.mark.parametrize(
    ("platform", "fields"),
    [
        (1, {"source": "小红书声明"}),
        (2, {"declaration": "视频号声明"}),
        (3, {"declaration": "抖音声明"}),
    ],
)
def test_declaration_consumer_reads_canonical_fields(
    platform: int, fields: dict[str, Any]
) -> None:
    item = {"platform": platform, "fields": fields}

    assert uploader_wrapper._fields_for(item, platform) == fields


@pytest.mark.parametrize(
    ("platform", "item", "expected"),
    [
        (
            1,
            {"platform": 1, "xiaohongshu": {"source": "小红书声明"}},
            {"source": "小红书声明"},
        ),
        (
            1,
            {"platform": 1, "source": "小红书声明"},
            {"source": "小红书声明"},
        ),
        (
            2,
            {"platform": 2, "tencent": {"declaration": "视频号声明"}},
            {"declaration": "视频号声明"},
        ),
        (
            2,
            {"platform": 2, "declaration": "视频号声明"},
            {"declaration": "视频号声明"},
        ),
        (
            3,
            {"platform": 3, "douyin": {"declaration": "抖音声明"}},
            {"declaration": "抖音声明"},
        ),
        (
            3,
            {"platform": 3, "declaration": "抖音声明"},
            {"declaration": "抖音声明"},
        ),
    ],
)
def test_declaration_consumer_keeps_legacy_shapes_readable(
    platform: int, item: dict[str, Any], expected: dict[str, Any]
) -> None:
    assert uploader_wrapper._fields_for(item, platform) == expected


def test_declaration_consumer_prefers_canonical_fields_over_legacy_fields() -> None:
    item = {
        "platform": 3,
        "fields": {"declaration": "canonical"},
        "douyin": {"declaration": "legacy"},
    }

    assert uploader_wrapper._fields_for(item, 3) == {"declaration": "canonical"}


@pytest.mark.parametrize(
    ("item", "exception_type", "message"),
    [
        ({"platform": 3, "fields": None}, TypeError, "object"),
        ({"platform": 3, "fields": {"declaration": True}}, ValueError, "类型非法"),
        ({"platform": 3, "fields": {"origin": True}}, ValueError, "非法字段"),
        ({"platform": 3, "douyin": None}, TypeError, "object"),
        ({"platform": 3, "douyin": {"declaration": 1}}, ValueError, "类型非法"),
        ({"platform": 3, "declaration": 1}, ValueError, "类型非法"),
        ({"platform": 3, "origin": True}, ValueError, "非法字段"),
    ],
)
def test_declaration_consumer_rejects_malformed_context(
    item: dict[str, Any], exception_type: type[Exception], message: str
) -> None:
    with pytest.raises(exception_type, match=message):
        uploader_wrapper._fields_for(item, 3)


@pytest.mark.parametrize("error_type", [None, RuntimeError, TimeoutError])
def test_declaration_context_clears_after_success_exception_or_timeout(
    error_type: type[BaseException] | None,
) -> None:
    first = {"platform": 3, "fields": {"declaration": "抖音声明"}}
    second = {"platform": 2, "fields": {"declaration": "视频号声明"}}

    if error_type is None:
        with uploader_wrapper._declaration_context(first):
            assert uploader_wrapper._active_fields(3) == {"declaration": "抖音声明"}
    else:
        with pytest.raises(error_type), uploader_wrapper._declaration_context(first):
            assert uploader_wrapper._active_fields(3) == {"declaration": "抖音声明"}
            raise error_type("item stopped")

    assert not hasattr(uploader_wrapper._local, "active")
    with uploader_wrapper._declaration_context(second):
        assert uploader_wrapper._active_fields(2) == {"declaration": "视频号声明"}
        assert uploader_wrapper._active_fields(3) == {}
    assert not hasattr(uploader_wrapper._local, "active")


def test_effective_items_use_isolated_context_for_platform_and_declaration() -> None:
    payloads = [
        {
            "fileList": ["douyin.mp4"],
            "accountList": ["douyin.json"],
            "type": 3,
            "title": "抖音 item",
            "tags": [],
            "platformFields": {"douyin": {"declaration": "no_need"}},
        },
        {
            "fileList": ["wechat.mp4"],
            "accountList": ["wechat.json"],
            "type": 2,
            "title": "视频号 item",
            "tags": [],
            "platformFields": {"wechat": {"declaration": "marketing"}},
        },
    ]
    items = [
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES).effective[0]
        for payload in payloads
    ]
    observed: list[tuple[int, dict[str, Any], dict[str, Any]]] = []

    def invoke(command: dict[str, Any]) -> None:
        observed.append(
            (
                command["type"],
                uploader_wrapper._active_fields(3).copy(),
                uploader_wrapper._active_fields(2).copy(),
            )
        )

    uploader_wrapper._execute_effective_group(items, invoke)

    assert observed == [
        (3, {"declaration": "无需添加自主声明"}, {}),
        (2, {}, {"declaration": "内容包含营销广告"}),
    ]
    assert not hasattr(uploader_wrapper._local, "active")


def test_effective_items_replace_context_for_same_platform_declarations() -> None:
    payloads = [
        {
            "fileList": ["first.mp4"],
            "accountList": ["douyin.json"],
            "type": 3,
            "title": "第一条",
            "tags": [],
            "platformFields": {"douyin": {"declaration": "no_need"}},
        },
        {
            "fileList": ["second.mp4"],
            "accountList": ["douyin.json"],
            "type": 3,
            "title": "第二条",
            "tags": [],
            "platformFields": {"douyin": {"declaration": "marketing"}},
        },
    ]
    items = [
        normalize_publish_payloads([payload], ACCOUNT_FIXTURES).effective[0]
        for payload in payloads
    ]
    observed: list[dict[str, Any]] = []

    uploader_wrapper._execute_effective_group(
        items,
        lambda _command: observed.append(uploader_wrapper._active_fields(3).copy()),
    )

    assert observed == [
        {"declaration": "无需添加自主声明"},
        {"declaration": "内容含营销推广信息"},
    ]
    assert not hasattr(uploader_wrapper._local, "active")


def test_effective_item_failure_clears_context_before_next_item() -> None:
    first_payload = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "失败 item",
        "tags": [],
        "platformFields": {"douyin": {"declaration": "no_need"}},
    }
    second_payload = {
        "fileList": ["wechat.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "后续 item",
        "tags": [],
        "platformFields": {"wechat": {"declaration": "marketing"}},
    }
    first = normalize_publish_payloads([first_payload], ACCOUNT_FIXTURES).effective[0]
    second = normalize_publish_payloads([second_payload], ACCOUNT_FIXTURES).effective[0]

    def fail(_command: dict[str, Any]) -> None:
        assert uploader_wrapper._active_fields(3) == {"declaration": "无需添加自主声明"}
        raise TimeoutError("item timeout")

    with pytest.raises(TimeoutError, match="timeout"):
        uploader_wrapper._execute_effective_group([first], fail)
    assert not hasattr(uploader_wrapper._local, "active")

    observed: list[dict[str, Any]] = []
    uploader_wrapper._execute_effective_group(
        [second],
        lambda _command: observed.append(uploader_wrapper._active_fields(2).copy()),
    )
    assert observed == [{"declaration": "内容包含营销广告"}]
    assert not hasattr(uploader_wrapper._local, "active")


def test_wrapper_fails_closed_without_effective_items_in_publish_request() -> None:
    app = Flask(__name__)
    app.testing = True
    calls: list[tuple[Any, ...]] = []

    def fake_official(*args: Any) -> None:
        calls.append(args)

    uploader_wrapper.set_pending_effective_items([])
    original = uploader_wrapper._ORIGINAL_POST_VIDEO_DOUYIN
    uploader_wrapper._ORIGINAL_POST_VIDEO_DOUYIN = fake_official
    try:

        def post_video() -> str:
            uploader_wrapper._inject_declaration_to_douyin(
                "标题", ["video.mp4"], [], ["douyin.json"]
            )
            return "ok"

        app.add_url_rule(
            "/postVideo", endpoint="postVideo", view_func=post_video, methods=["POST"]
        )
        with pytest.raises(RuntimeError, match="effective"):
            app.test_client().post("/postVideo")
    finally:
        uploader_wrapper._ORIGINAL_POST_VIDEO_DOUYIN = original
        uploader_wrapper.set_pending_effective_items([])

    assert calls == []


def test_douyin_timer_effective_snapshot_keeps_minute_and_absolute_local_datetime() -> None:
    payload = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "分钟定时",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 1,
        "dailyTimes": ["14:37"],
        "startDays": 1,
    }

    result = normalize_publish_payloads(
        [payload],
        ACCOUNT_FIXTURES,
        now=datetime(2026, 8, 27, 23, 50, tzinfo=UTC).replace(tzinfo=None),
    )
    item = result.effective[0]

    assert result.submitted[0]["dailyTimes"] == ["14:37"]
    assert item.effective["dailyTimes"] == ["14:37"]
    assert item.effective["publishDatetimes"] == ["2026-08-29T14:37:00"]


def test_douyin_timer_minute_boundaries_and_mixed_immediate_timer_are_stable() -> None:
    timer = {
        "fileList": [
            "douyin-1.mp4",
            "douyin-2.mp4",
            "douyin-3.mp4",
            "douyin-4.mp4",
        ],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "边界",
        "tags": [],
        "enableTimer": True,
        "videosPerDay": 4,
        "dailyTimes": ["00:00", "23:29", "23:30", "23:59"],
        "startDays": 0,
    }
    immediate = {
        "fileList": ["douyin.mp4"],
        "accountList": ["douyin.json"],
        "type": 3,
        "title": "立即",
        "tags": [],
        "enableTimer": False,
    }

    result = normalize_publish_payloads(
        [immediate, timer],
        ACCOUNT_FIXTURES,
        now=__import__("datetime").datetime(2026, 8, 27, 12, 0),
    )

    assert result.effective[0].effective["enableTimer"] is False
    assert "publishDatetimes" not in result.effective[0].effective
    assert result.effective[1].effective["publishDatetimes"] == [
        "2026-08-28T00:00:00",
        "2026-08-28T23:29:00",
        "2026-08-28T23:30:00",
        "2026-08-28T23:59:00",
    ]
