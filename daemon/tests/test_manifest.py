"""manifest 批量导入解析服务测试（ADR-0002 权威）。

控制者预确认 seam：`parse_manifest(folder_path, platform) -> ManifestResult`
（校验分级：hard_errors 整批拒绝 / warnings 软提示进待确认）
+ `confirm_import(entries, *, account_id, task_store, accounts) -> [task_ids]`
（逐条走 create_task 同一发布通道）。

测试断言：解析字段映射、分级校验（硬/软）、标题兜底、schedule 区间、
confirm 逐条生成 task + job（与发布页同一通道）、逐条覆盖账号/平台。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount
from posthub.manifest import ConfirmEntry, confirm_import, parse_manifest
from posthub.tasks import (
    AccountPlatformMismatchError,
    InMemoryTaskStore,
    TaskValidationError,
    UnknownAccountError,
)

TIME_FMT = "%Y-%m-%d %H:%M:%S"


def make_batch(tmp_path, manifest: dict, files: list[str] | None = None) -> Path:
    """创建批次文件夹：默认含 视频1.mp4 / 视频2.mp4 / cover1.jpg + manifest.json。"""
    folder = tmp_path / "batch"
    folder.mkdir(exist_ok=True)
    for name in files or ["视频1.mp4", "视频2.mp4", "cover1.jpg"]:
        p = folder / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
    (folder / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return folder


def valid_manifest(**overrides) -> dict:
    base = {
        "version": 1,
        "videos": [
            {
                "file": "视频1.mp4",
                "title": "标题1",
                "content": "正文1",
                "tags": ["话题1"],
                "cover_landscape": "cover1.jpg",
                "cover_portrait": "",
                "schedule": (datetime.now() + timedelta(days=3)).strftime(TIME_FMT),
            },
            {"file": "视频2.mp4", "title": "标题2"},
        ],
    }
    base.update(overrides)
    return base


def make_task_store():
    accounts = InMemoryAccountStore()
    accounts.create(
        NewAccount(
            platform="douyin",
            name="抖音",
            profile_dir="/tmp/p-douyin",
            cdp_port=9222,
        )
    )
    accounts.create(
        NewAccount(
            platform="xiaohongshu",
            name="小红书",
            profile_dir="/tmp/p-xhs",
            cdp_port=9223,
        )
    )
    return InMemoryTaskStore(accounts), accounts


# ---- parse_manifest：正常解析 ----

def test_parse_valid_manifest_maps_fields(tmp_path) -> None:
    folder = make_batch(tmp_path, valid_manifest())
    result = parse_manifest(str(folder), "douyin")

    assert result.hard_errors == []
    assert result.version == 1
    assert len(result.entries) == 2

    e0 = result.entries[0]
    assert e0.file == str((folder / "视频1.mp4").resolve())
    assert e0.title == "标题1"
    assert e0.content == "正文1"
    assert e0.tags == ["话题1"]
    assert e0.cover_landscape == str((folder / "cover1.jpg").resolve())
    assert e0.cover_portrait is None  # 空字符串 = 无封面
    assert e0.schedule is not None
    assert e0.warnings == []

    e1 = result.entries[1]
    assert e1.file == str((folder / "视频2.mp4").resolve())
    assert e1.title == "标题2"
    assert e1.schedule is None  # 不写 = 立即发布


def test_parse_file_in_subdirectory(tmp_path) -> None:
    folder = make_batch(
        tmp_path,
        {"version": 1, "videos": [{"file": "sub/视频1.mp4", "title": "子目录"}]},
        files=["sub/视频1.mp4"],
    )
    result = parse_manifest(str(folder), "douyin")
    assert result.hard_errors == []
    assert result.entries[0].file == str((folder / "sub/视频1.mp4").resolve())


# ---- parse_manifest：硬报错（整批拒绝）----

def test_parse_missing_manifest_hard_error(tmp_path) -> None:
    folder = tmp_path / "empty"
    folder.mkdir()
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert result.hard_errors[0].index is None
    assert "manifest.json" in result.hard_errors[0].message
    assert result.entries == []


def test_parse_invalid_json_hard_error(tmp_path) -> None:
    folder = tmp_path / "bad"
    folder.mkdir()
    (folder / "manifest.json").write_text("{not json", encoding="utf-8")
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "JSON" in result.hard_errors[0].message


def test_parse_unsupported_version_hard_error(tmp_path) -> None:
    folder = make_batch(tmp_path, {"version": 2, "videos": []})
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "版本" in result.hard_errors[0].message


def test_parse_missing_videos_hard_error(tmp_path) -> None:
    folder = make_batch(tmp_path, {"version": 1})
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "videos" in result.hard_errors[0].message


def test_parse_missing_file_field_hard_error(tmp_path) -> None:
    folder = make_batch(tmp_path, valid_manifest(videos=[{"title": "x"}]))
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert result.hard_errors[0].index == 0
    assert "file" in result.hard_errors[0].message
    assert result.entries == []


def test_parse_missing_file_and_empty_title_no_crash(tmp_path) -> None:
    """file 缺失且 title 为空：不得 NameError，仍整批拒绝。"""
    folder = make_batch(tmp_path, valid_manifest(videos=[{"title": ""}]))
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "file" in result.hard_errors[0].message
    assert result.entries == []


def test_parse_file_not_exists_hard_error(tmp_path) -> None:
    folder = make_batch(tmp_path, valid_manifest(videos=[{"file": "不存在.mp4"}]))
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "不存在" in result.hard_errors[0].message


def test_parse_duplicate_file_hard_error(tmp_path) -> None:
    folder = make_batch(
        tmp_path,
        valid_manifest(videos=[{"file": "视频1.mp4"}, {"file": "视频1.mp4"}]),
    )
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "重复" in result.hard_errors[0].message


def test_parse_cover_missing_hard_error(tmp_path) -> None:
    folder = make_batch(
        tmp_path,
        valid_manifest(videos=[{"file": "视频1.mp4", "cover_landscape": "no-cover.jpg"}]),
    )
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "封面" in result.hard_errors[0].message


def test_parse_title_too_long_platform_specific(tmp_path) -> None:
    long_title = "很" * 25  # 25 字：超小红书 20，未超抖音 30
    folder = make_batch(
        tmp_path, valid_manifest(videos=[{"file": "视频1.mp4", "title": long_title}])
    )
    assert parse_manifest(str(folder), "douyin").hard_errors == []
    res_xhs = parse_manifest(str(folder), "xiaohongshu")
    assert len(res_xhs.hard_errors) == 1
    assert "标题" in res_xhs.hard_errors[0].message


def test_parse_schedule_invalid_format_hard_error(tmp_path) -> None:
    folder = make_batch(
        tmp_path,
        valid_manifest(videos=[{"file": "视频1.mp4", "schedule": "明天早上"}]),
    )
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "格式" in result.hard_errors[0].message


def test_parse_schedule_too_soon_hard_error(tmp_path) -> None:
    folder = make_batch(
        tmp_path,
        valid_manifest(
            videos=[
                {
                    "file": "视频1.mp4",
                    "schedule": (datetime.now() + timedelta(minutes=30)).strftime(TIME_FMT),
                }
            ]
        ),
    )
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert result.hard_errors[0].index == 0
    assert "2 小时" in result.hard_errors[0].message


def test_parse_schedule_beyond_platform_window_hard_error(tmp_path) -> None:
    # 平台化窗口（对齐约束注册表）：抖音 schedule_max = 14 天，15 天才超窗
    folder = make_batch(
        tmp_path,
        valid_manifest(
            videos=[
                {
                    "file": "视频1.mp4",
                    "schedule": (datetime.now() + timedelta(days=15)).strftime(TIME_FMT),
                }
            ]
        ),
    )
    result = parse_manifest(str(folder), "douyin")
    assert len(result.hard_errors) == 1
    assert "336 小时" in result.hard_errors[0].message  # 14 天 = 336 小时


def test_parse_schedule_within_douyin_14day_window_ok(tmp_path) -> None:
    # 抖音窗口 14 天：8 天应通过（修复前硬编码 7 天会误拒绝）
    folder = make_batch(
        tmp_path,
        valid_manifest(
            videos=[
                {
                    "file": "视频1.mp4",
                    "schedule": (datetime.now() + timedelta(days=8)).strftime(TIME_FMT),
                }
            ]
        ),
    )
    result = parse_manifest(str(folder), "douyin")
    assert result.hard_errors == []
    assert len(result.entries) == 1
    assert result.entries[0].schedule is not None


# ---- parse_manifest：软提示（进待确认 + 黄色标注）----

def test_parse_empty_title_uses_filename_fallback(tmp_path) -> None:
    folder = make_batch(
        tmp_path, valid_manifest(videos=[{"file": "视频1.mp4", "title": ""}])
    )
    result = parse_manifest(str(folder), "douyin")
    assert result.hard_errors == []
    assert result.entries[0].title == "视频1"  # 文件名去扩展名兜底
    assert any("文件名" in w for w in result.entries[0].warnings)


def test_parse_tags_over_10_xiaohongshu_soft_warning(tmp_path) -> None:
    tags = [f"话题{i}" for i in range(12)]
    folder = make_batch(
        tmp_path, valid_manifest(videos=[{"file": "视频1.mp4", "tags": tags}])
    )
    result = parse_manifest(str(folder), "xiaohongshu")
    assert result.hard_errors == []
    assert len(result.entries) == 1
    assert any("tags" in w for w in result.entries[0].warnings)


def test_parse_tags_over_10_douyin_no_warning(tmp_path) -> None:
    tags = [f"话题{i}" for i in range(12)]
    folder = make_batch(
        tmp_path,
        valid_manifest(videos=[{"file": "视频1.mp4", "title": "有标题", "tags": tags}]),
    )
    result = parse_manifest(str(folder), "douyin")
    assert result.hard_errors == []
    assert result.entries[0].warnings == []


# ---- confirm_import：同一发布通道落库 ----

def test_confirm_import_creates_tasks_via_create_task(tmp_path) -> None:
    store, accounts = make_task_store()
    entries = [
        ConfirmEntry(
            file="/tmp/v1.mp4", title="批量1", content="正文1",
            tags=["a"], account_id=1, platform="douyin",
        ),
        ConfirmEntry(file="/tmp/v2.mp4", title="批量2", account_id=1, platform="douyin"),
    ]
    task_ids = confirm_import(entries, account_id=1, task_store=store, accounts=accounts)

    assert task_ids == [1, 2]

    t1 = store.get_task(1)
    assert t1.title == "批量1"
    assert t1.video_path == "/tmp/v1.mp4"
    assert t1.caption == "正文1"
    assert t1.schedule_policy == "immediate"
    assert t1.status == "pending"

    jobs1 = store.list_jobs(1)
    assert len(jobs1) == 1
    assert jobs1[0].account_id == 1
    assert jobs1[0].platform == "douyin"
    assert jobs1[0].status == "pending"


def test_confirm_import_scheduled_sets_publish_at(tmp_path) -> None:
    store, accounts = make_task_store()
    schedule = (datetime.now() + timedelta(days=3)).strftime(TIME_FMT)
    entries = [
        ConfirmEntry(file="/tmp/v1.mp4", title="定时", schedule=schedule, account_id=1, platform="douyin")
    ]
    task_ids = confirm_import(entries, account_id=1, task_store=store, accounts=accounts)
    t = store.get_task(task_ids[0])
    assert t.schedule_policy == "scheduled"
    assert t.publish_at == schedule


def test_confirm_import_entry_overrides_account(tmp_path) -> None:
    store, accounts = make_task_store()
    # 批次默认账号 1（douyin），该条覆盖为账号 2（xiaohongshu）
    entries = [
        ConfirmEntry(file="/tmp/v1.mp4", title="跨平台", account_id=2, platform="xiaohongshu")
    ]
    task_ids = confirm_import(entries, account_id=1, task_store=store, accounts=accounts)
    jobs = store.list_jobs(task_ids[0])
    assert jobs[0].account_id == 2
    assert jobs[0].platform == "xiaohongshu"


def test_confirm_import_platform_derived_from_account(tmp_path) -> None:
    store, accounts = make_task_store()
    entries = [ConfirmEntry(file="/tmp/v1.mp4", title="x", account_id=1)]
    task_ids = confirm_import(entries, account_id=1, task_store=store, accounts=accounts)
    jobs = store.list_jobs(task_ids[0])
    assert jobs[0].platform == "douyin"


def test_confirm_import_unknown_account_raises(tmp_path) -> None:
    store, accounts = make_task_store()
    entries = [ConfirmEntry(file="/tmp/v1.mp4", title="x", account_id=999, platform="douyin")]
    with pytest.raises(UnknownAccountError):
        confirm_import(entries, account_id=1, task_store=store, accounts=accounts)


def test_confirm_import_platform_mismatch_raises(tmp_path) -> None:
    store, accounts = make_task_store()
    # 账号 2 是小红书，平台却填 douyin → create_task 不变量拦截
    entries = [ConfirmEntry(file="/tmp/v1.mp4", title="x", account_id=2, platform="douyin")]
    with pytest.raises(AccountPlatformMismatchError):
        confirm_import(entries, account_id=1, task_store=store, accounts=accounts)


def test_confirm_import_schedule_too_soon_rejected(tmp_path) -> None:
    store, accounts = make_task_store()
    schedule = (datetime.now() + timedelta(minutes=30)).strftime(TIME_FMT)
    entries = [
        ConfirmEntry(file="/tmp/v1.mp4", title="x", schedule=schedule, account_id=1, platform="douyin")
    ]
    with pytest.raises(TaskValidationError):
        confirm_import(entries, account_id=1, task_store=store, accounts=accounts)


def test_confirm_import_does_not_partial_persist_on_failure(tmp_path) -> None:
    store, accounts = make_task_store()
    entries = [
        ConfirmEntry(file="/tmp/v1.mp4", title="第一条", account_id=1, platform="douyin"),
        ConfirmEntry(file="/tmp/v2.mp4", title="x", account_id=999, platform="douyin"),
    ]
    with pytest.raises(UnknownAccountError):
        confirm_import(entries, account_id=1, task_store=store, accounts=accounts)
    # 失败的 confirm 不得残留任何 task
    assert store.get_task(1) is None
