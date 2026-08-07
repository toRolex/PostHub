"""账号存储服务测试：CRUD + 平台/端口唯一约束 + 状态字段。

存储 seam（控制者预确认）：account CRUD + 唯一约束 + 状态流转。
InMemory 与 SQLite 实现可互换，本测试参数化两种实现。
"""

from __future__ import annotations

import pytest

from posthub.accounts import (
    AccountConflictError,
    InMemoryAccountStore,
    NewAccount,
    SqliteAccountStore,
)


def make_new(
    platform: str = "douyin",
    name: str = "抖音一号",
    cdp_port: int = 9222,
    **kw,
) -> NewAccount:
    return NewAccount(
        platform=platform,  # type: ignore[arg-type]
        name=name,
        profile_dir=kw.pop("profile_dir", f"/tmp/posthub-profile-{cdp_port}"),
        cdp_port=cdp_port,
        **kw,
    )


@pytest.fixture(params=["in-memory", "sqlite"])
def store(tmp_path, request):
    if request.param == "in-memory":
        s = InMemoryAccountStore()
    else:
        s = SqliteAccountStore(tmp_path / "accounts.db")
    yield s
    s.close()


def test_create_assigns_incrementing_id_and_defaults(store) -> None:
    a1 = store.create(make_new())
    a2 = store.create(make_new(platform="xiaohongshu", cdp_port=9223))

    assert a1.id == 1
    assert a2.id == 2
    assert a1.status == "active"
    assert a1.last_login_at is None
    assert a1.created_at
    assert a1.updated_at


def test_get_returns_created_account(store) -> None:
    created = store.create(make_new())
    got = store.get(created.id)

    assert got is not None
    assert got == created
    assert got.platform == "douyin"
    assert got.name == "抖音一号"
    assert got.cdp_port == 9222


def test_get_missing_returns_none(store) -> None:
    assert store.get(9999) is None


def test_list_empty_then_after_create(store) -> None:
    assert store.list() == []

    store.create(make_new())
    store.create(make_new(platform="wechat", cdp_port=9230))

    accounts = store.list()
    assert len(accounts) == 2
    assert {a.platform for a in accounts} == {"douyin", "wechat"}


def test_delete_removes_record(store) -> None:
    created = store.create(make_new())
    assert store.delete(created.id) is True
    assert store.get(created.id) is None
    assert store.list() == []


def test_delete_missing_returns_false(store) -> None:
    assert store.delete(424242) is False


def test_same_platform_same_port_conflict_raises(store) -> None:
    store.create(make_new(cdp_port=9222))
    with pytest.raises(AccountConflictError):
        store.create(make_new(cdp_port=9222))


def test_same_port_different_platform_is_allowed(store) -> None:
    store.create(make_new(platform="douyin", cdp_port=9222))
    # 不同平台可复用端口（各绑定独立 user-data-dir）
    store.create(make_new(platform="xiaohongshu", cdp_port=9222))


def test_new_account_status_field_is_preserved(store) -> None:
    created = store.create(make_new(status="needs_relogin"))
    assert created.status == "needs_relogin"
    assert store.get(created.id).status == "needs_relogin"


def test_sqlite_persists_across_reopen(tmp_path) -> None:
    db = tmp_path / "accounts.db"
    s1 = SqliteAccountStore(db)
    created = s1.create(make_new())
    s1.close()

    s2 = SqliteAccountStore(db)
    try:
        assert s2.get(created.id) is not None
        assert s2.list() == [created]
    finally:
        s2.close()
