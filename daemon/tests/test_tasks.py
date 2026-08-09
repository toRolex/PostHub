"""任务创建服务测试（ADR-0001 task / platform_job 表 + 创建 seam）。

控制者预确认 seam：`create_task(NewTaskSpec) -> (task, jobs)`。
测试断言：落库结果、初始状态（task pending / 每个 job pending）、job 排期继承 task、
平台/账号不匹配报错。InMemory 与 SQLite 实现可互换，参数化两种实现。
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from posthub.accounts import InMemoryAccountStore, NewAccount, SqliteAccountStore
from posthub.constraints import HOUR
from posthub.tasks import (
    AccountPlatformMismatchError,
    InMemoryTaskStore,
    NewTaskSpec,
    PlatformJobSpec,
    SqliteTaskStore,
    TaskValidationError,
    UnknownAccountError,
)


def make_accounts(store) -> None:
    """每平台一个账号：douyin=1, xiaohongshu=2, wechat=3。"""
    store.create(
        NewAccount(
            platform="douyin",
            name="抖音一号",
            profile_dir="/tmp/p-douyin",
            cdp_port=9222,
        )
    )
    store.create(
        NewAccount(
            platform="xiaohongshu",
            name="小红书",
            profile_dir="/tmp/p-xhs",
            cdp_port=9223,
        )
    )
    store.create(
        NewAccount(
            platform="wechat",
            name="视频号",
            profile_dir="/tmp/p-wechat",
            cdp_port=9224,
        )
    )


@pytest.fixture(params=["in-memory", "sqlite"])
def task_store(tmp_path, request):
    if request.param == "in-memory":
        accounts = InMemoryAccountStore()
    else:
        accounts = SqliteAccountStore(tmp_path / "accounts.db")
    make_accounts(accounts)

    if request.param == "in-memory":
        s = InMemoryTaskStore(accounts)
    else:
        s = SqliteTaskStore(tmp_path / "tasks.db", accounts)
    yield s
    s.close()
    accounts.close()


def make_spec(**overrides) -> NewTaskSpec:
    base = dict(
        title="春日踏青",
        video_path="/tmp/video.mp4",
        jobs=[PlatformJobSpec(platform="douyin", account_id=1)],
    )
    base.update(overrides)
    return NewTaskSpec(**base)


def test_create_immediate_task_persists_task_and_job(task_store) -> None:
    task, jobs = task_store.create_task(
        make_spec(title="春日踏青", caption="一起出发", tags=["vlog", "春"])
    )

    assert task.id == 1
    assert task.status == "pending"
    assert task.title == "春日踏青"
    assert task.caption == "一起出发"
    assert task.schedule_policy == "immediate"
    assert task.publish_mode == "platform_time"
    assert task.publish_at is None
    assert task.silent == 0
    assert task.video_path == "/tmp/video.mp4"
    assert task.created_at and task.updated_at

    assert len(jobs) == 1
    job = jobs[0]
    assert job.task_id == task.id
    assert job.platform == "douyin"
    assert job.account_id == 1
    assert job.status == "pending"
    # 排期字段可空 = 继承 task
    assert job.schedule_policy is None
    assert job.publish_mode is None
    assert job.publish_at is None
    assert job.attempt_count == 0


def test_create_scheduled_task_with_multiple_platforms(task_store) -> None:
    publish_at = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    task, jobs = task_store.create_task(
        make_spec(
            title="定时发布",
            schedule_policy="scheduled",
            publish_at=publish_at,
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
                PlatformJobSpec(platform="wechat", account_id=3),
            ],
        )
    )

    assert task.status == "pending"
    assert task.schedule_policy == "scheduled"
    assert task.publish_at == publish_at
    assert len(jobs) == 3
    assert {j.platform for j in jobs} == {"douyin", "xiaohongshu", "wechat"}
    assert all(j.status == "pending" for j in jobs)
    assert all(j.publish_at is None for j in jobs)  # 继承 task


def test_get_task_and_list_jobs(task_store) -> None:
    task, jobs = task_store.create_task(make_spec())
    got = task_store.get_task(task.id)
    assert got == task

    listed = task_store.list_jobs(task.id)
    assert listed == jobs
    assert [j.task_id for j in listed] == [task.id]


def test_account_platform_mismatch_raises(task_store) -> None:
    # douyin 平台选了小红书账号 → 不变量 job.platform == account.platform 违反
    with pytest.raises(AccountPlatformMismatchError):
        task_store.create_task(
            make_spec(jobs=[PlatformJobSpec(platform="douyin", account_id=2)])
        )


def test_unknown_account_raises(task_store) -> None:
    with pytest.raises(UnknownAccountError):
        task_store.create_task(
            make_spec(jobs=[PlatformJobSpec(platform="douyin", account_id=999)])
        )


def test_scheduled_without_publish_at_raises(task_store) -> None:
    with pytest.raises(TaskValidationError):
        task_store.create_task(
            make_spec(schedule_policy="scheduled", publish_at=None)
        )


def test_empty_title_raises(task_store) -> None:
    with pytest.raises(TaskValidationError):
        task_store.create_task(make_spec(title="  "))


def test_empty_jobs_raises(task_store) -> None:
    with pytest.raises(TaskValidationError):
        task_store.create_task(make_spec(jobs=[]))


def test_scheduled_too_soon_rejected_by_backend(task_store) -> None:
    """后端防御性校验：定时提前量不足平台约束（小红书有效最小 2h）。"""
    too_soon = (datetime.now() + timedelta(minutes=30)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    with pytest.raises(TaskValidationError):
        task_store.create_task(
            make_spec(
                schedule_policy="scheduled",
                publish_at=too_soon,  # 距 now 仅 30 分钟 < 2h
                jobs=[PlatformJobSpec(platform="xiaohongshu", account_id=2)],
            )
        )


def test_failed_validation_leaves_no_partial_state(task_store) -> None:
    with pytest.raises(AccountPlatformMismatchError):
        task_store.create_task(
            make_spec(jobs=[PlatformJobSpec(platform="douyin", account_id=2)])
        )
    # 校验失败不得残留 task/job
    assert task_store.get_task(1) is None
    assert task_store.list_jobs(1) == []


def test_silent_flag_persisted(task_store) -> None:
    task, _ = task_store.create_task(make_spec(silent=True))
    assert task.silent == 1


def test_sqlite_persists_across_reopen(tmp_path) -> None:
    accounts = SqliteAccountStore(tmp_path / "accounts.db")
    make_accounts(accounts)
    db = tmp_path / "tasks.db"
    s1 = SqliteTaskStore(db, accounts)
    task, jobs = s1.create_task(make_spec())
    s1.close()

    s2 = SqliteTaskStore(db, accounts)
    try:
        assert s2.get_task(task.id) == task
        assert s2.list_jobs(task.id) == jobs
    finally:
        s2.close()
        accounts.close()


def test_min_lead_time_unit_constant() -> None:
    assert HOUR == 3600


# ---- delete_account_jobs：删除账号时清理关联 job / 空 task / 日志（#15）----

def test_delete_account_jobs_removes_jobs_and_empty_tasks(task_store) -> None:
    # 账号 1（douyin）独占的任务 → 删除后 task 一并删除
    task1, jobs1 = task_store.create_task(
        make_spec(jobs=[PlatformJobSpec(platform="douyin", account_id=1)])
    )
    # 跨平台任务（douyin + xhs）→ 删账号 1 后保留 xhs job，task 状态重算
    task2, jobs2 = task_store.create_task(
        make_spec(
            jobs=[
                PlatformJobSpec(platform="douyin", account_id=1),
                PlatformJobSpec(platform="xiaohongshu", account_id=2),
            ]
        )
    )
    task_store.add_log(
        "info", "daemon", "测试日志", task_id=task1.id, job_id=jobs1[0].id
    )

    task_store.delete_account_jobs(1)

    # task1 无剩余 job → 删除（含日志）
    assert task_store.get_task(task1.id) is None
    assert task_store.list_jobs(task1.id) == []
    # task2 保留 xhs job → 状态重算为 pending
    detail = task_store.get_task_detail(task2.id)
    assert detail is not None
    assert [j.platform for j in detail.jobs] == ["xiaohongshu"]
    assert detail.jobs[0].account_id == 2
    assert detail.task.status == "pending"
    # task1 的日志已清理
    assert all(e.task_id != task1.id for e in task_store.list_logs())


def test_delete_account_jobs_ignores_other_accounts(task_store) -> None:
    task, jobs = task_store.create_task(
        make_spec(jobs=[PlatformJobSpec(platform="xiaohongshu", account_id=2)])
    )
    task_store.delete_account_jobs(1)
    detail = task_store.get_task_detail(task.id)
    assert detail is not None
    assert len(detail.jobs) == 1
    assert detail.jobs[0].account_id == 2
