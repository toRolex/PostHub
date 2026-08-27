"""EffectiveBatchItem normalization 与发布执行 adapter 契约测试。"""

from __future__ import annotations

from copy import deepcopy
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
        "default_platform_fields": {"xiaohongshu": {"source": "self_declare"}},
    },
    {
        "id": 12,
        "type": 2,
        "filePath": "wechat.json",
        "userName": "视频号账号",
        "status": 1,
        "default_platform_fields": {
            "wechat": {"declaration": "no_label", "origin": True}
        },
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
                "platformFields": {"xiaohongshu": {"source": "marketing"}},
            },
            1,
            {"xiaohongshu": {"source": "marketing"}},
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
                "platformFields": {
                    "wechat": {"declaration": "marketing", "origin": False}
                },
            },
            2,
            {"wechat": {"declaration": "marketing", "origin": False}},
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
    for field in ("thumbnail", "productLink", "productTitle", "isDraft"):
        if field in payload:
            assert item.effective[field] == payload[field]


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


def test_task_platform_fields_override_account_defaults_without_dropping_other_defaults() -> (
    None
):
    payload = {
        "fileList": ["wechat.mp4"],
        "accountList": ["wechat.json"],
        "type": 2,
        "title": "覆盖声明原创",
        "tags": [],
        "enableTimer": False,
        "platformFields": {"wechat": {"origin": False}},
    }

    result = normalize_publish_payloads([payload], ACCOUNT_FIXTURES)

    assert result.effective[0].effective["platformFields"] == {
        "wechat": {"declaration": "no_label", "origin": False}
    }
    assert result.effective[0].account_snapshot.default_platform_fields == {
        "wechat": {"declaration": "no_label", "origin": True}
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
