"""ticket 11「验收：全链路端到端 smoke」契约级验收线。

在**隔离临时 BASE_DIR** 下启动官方后端（`POSTHUB_BASE_DIR` 指向 pytest tmp，
不影响仓库 daemon/db、不触碰真实凭证），串起全链路契约校验分支：

- 启动壳拉起后端 → 探活 127.0.0.1:5409 → `/getAccounts` 200 + 官方 `{code,msg,data}` 格式
- 官方 database.db **自动初始化**：db/database.db 与 user_info / file_records 表就绪
- `/uploadSave` → `/getFiles` → `/deleteFile` 素材链往返
- `/postVideo` 参数校验错误被**正确中继**（400 + code + 官方 msg）
- `/postVideoBatch` 非数组请求被官方拒绝（400）

全程**不真触发发布**：/postVideo 只走官方参数校验失败分支，/postVideoBatch 只走
请求级错误分支。`/login`(SSE) 需真人扫码与真实浏览器，不在自动链内，其契约
（URL/query 构造 + parseSse* 解析）由前端 `web/src/api/official.test.ts` 单测覆盖。
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Iterator

import pytest

DAEMON_DIR = Path(__file__).resolve().parent.parent
PORT = 5409
BASE_URL = f"http://127.0.0.1:{PORT}"


def _tcp_ready() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def _get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _post_json(url: str, payload: object) -> tuple[int, dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _multipart_upload(url: str, filename: str, content: bytes) -> tuple[int, dict]:
    boundary = uuid.uuid4().hex
    body = (
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: video/mp4\r\n\r\n"
        ).encode()
        + content
        + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _wait_ready(timeout: float = 25.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _tcp_ready():
            try:
                status, _ = _get(f"{BASE_URL}/getAccounts")
                if status == 200:
                    return True
            except OSError:
                pass
        time.sleep(0.5)
    return False


@pytest.fixture(scope="module")
def backend(tmp_path_factory) -> Iterator[tuple[str, Path]]:
    """在隔离 BASE_DIR 启动官方后端，返回 (base url, BASE_DIR)；拆除时停进程。"""
    base = tmp_path_factory.mktemp("e2e")
    # 不预建 videoFile/：验证后端启动时补齐官方不自动建的数据目录（regression：上传 Errno 2）。
    env = {**os.environ, "POSTHUB_BASE_DIR": str(base)}
    assert not _tcp_ready(), "端口 5409 被占用，请先释放残留后端进程"

    proc = subprocess.Popen(
        [sys.executable, str(DAEMON_DIR / "run_backend.py")],
        cwd=DAEMON_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        assert _wait_ready(), "官方后端未在 25s 内就绪（TCP 5409 + /getAccounts 200）"
        yield BASE_URL, base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_backend_reachable_and_db_auto_initialized(backend: tuple[str, Path]) -> None:
    """后端已监听 5409，且官方 database.db 已由 db_init 自动初始化（两表就绪）。"""
    url, base = backend
    assert url == BASE_URL and _tcp_ready()
    db_path = Path(base) / "db" / "database.db"
    assert db_path.exists(), "后端应自动创建 db/database.db"
    with sqlite3.connect(db_path) as conn:
        tables = {
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {"user_info", "file_records"} <= tables


def test_video_file_dir_auto_created(backend: tuple[str, Path]) -> None:
    """regression：后端启动即补齐官方不自动建的 videoFile/，否则 /uploadSave 首传抛 Errno 2。

    fixture 不再预建该目录（见 backend fixture），此断言失败即复现生产机
    「upload failed: [Errno 2] No such file or directory: .../videoFile/...」。
    """
    _, base = backend
    assert (base / "videoFile").is_dir(), "后端应自动创建 videoFile/ 数据目录"


def test_get_accounts_200_official_format(backend: tuple[str, Path]) -> None:
    """契约 smoke：/getAccounts 返回官方格式（code 字段），无需登录。"""
    url, _ = backend
    status, body = _get(f"{url}/getAccounts")
    assert status == 200
    assert {"code", "msg", "data"} <= set(body)
    assert body["code"] == 200
    assert isinstance(body["data"], list)


def test_get_files_200_official_format(backend: tuple[str, Path]) -> None:
    """契约 smoke：/getFiles 返回官方格式（code 字段），data 为数组。"""
    url, _ = backend
    status, body = _get(f"{url}/getFiles")
    assert status == 200
    assert body["code"] == 200
    assert isinstance(body["data"], list)


def test_post_video_missing_body_error_relayed(backend: tuple[str, Path]) -> None:
    """契约 smoke：/postVideo 空 body → 官方 400 校验错误被正确中继。"""
    url, _ = backend
    status, body = _post_json(f"{url}/postVideo", {})
    assert status == 400
    assert body["code"] == 400
    assert body["msg"], "官方应返回非空错误信息"


def test_post_video_missing_filelist_error_relayed(backend: tuple[str, Path]) -> None:
    """契约 smoke：/postVideo 缺 fileList → 官方 400「文件列表不能为空」被中继。"""
    url, _ = backend
    payload = {"accountList": ["a.json"], "type": 1, "title": "t"}
    status, body = _post_json(f"{url}/postVideo", payload)
    assert status == 400
    assert body["code"] == 400
    assert "文件列表" in body["msg"]


def test_post_video_batch_non_array_rejected(backend: tuple[str, Path]) -> None:
    """契约 smoke：/postVideoBatch 请求体非数组 → 官方 400 被中继。"""
    url, _ = backend
    status, body = _post_json(f"{url}/postVideoBatch", {})
    assert status == 400
    assert body["code"] == 400
    assert "array" in body["msg"].lower()


def test_delete_file_invalid_id_400(backend: tuple[str, Path]) -> None:
    """契约 smoke：/deleteFile 非法 id → 官方 400 校验错误被中继。"""
    url, _ = backend
    status, body = _get(f"{url}/deleteFile?id=abc")
    assert status == 400
    assert body["code"] == 400
    assert body["msg"]


def test_upload_cookie_missing_file_error_relayed(backend: tuple[str, Path]) -> None:
    """契约 smoke：/uploadCookie 缺文件 → 官方 400 校验错误被中继。"""
    url, _ = backend
    req = urllib.request.Request(url + "/uploadCookie", data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            status, body = resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        status, body = e.code, json.loads(e.read())
    assert status == 400
    assert {"code", "msg", "data"} <= set(body)
    assert body["msg"], "官方应返回非空错误信息"


def test_download_cookie_missing_filepath_error_relayed(
    backend: tuple[str, Path],
) -> None:
    """契约 smoke：/downloadCookie 缺 filePath → 官方 400 校验错误被中继。

    官方实现此处 HTTP 400 但 body `code:500`（sau_backend.py 内部写法不一致），
    中继即把该 `{code,msg,data}` 原样透传给前端——这里只断言 HTTP 400 + 官方
    结构 + 非空 msg，不断言 code 具体值，避免把官方内部不一致固化成契约。
    """
    url, _ = backend
    status, body = _get(f"{url}/downloadCookie")
    assert status == 400
    assert {"code", "msg", "data"} <= set(body)
    assert body["msg"], "官方应返回非空错误信息"


def test_get_account_defaults_returns_empty_dict_initially(
    backend: tuple[str, Path],
) -> None:
    """新端点契约 smoke：/getAccountDefaults 返 `{code,msg,data}` + data 为 dict。"""
    url, _ = backend
    status, body = _get(f"{url}/getAccountDefaults")
    assert status == 200
    assert {"code", "msg", "data"} <= set(body)
    assert isinstance(body["data"], dict)
    # 增量迁移后默认空
    assert body["data"] == {}


def test_post_video_with_platform_fields_pass_through(
    backend: tuple[str, Path],
) -> None:
    """issue #43：/postVideo 接受 platform_fields 字段。

    这里只验证 seam 接受该字段且校验失败时返 400（不会触发真实发布流程）。
    """
    url, _ = backend
    payload = {
        "accountList": ["a.json"],
        "type": 1,
        "title": "t",
        "platformFields": {
            "wechat": {"declaration": "no_label"},
            "douyin": {"declaration": "no_need"},
            "xiaohongshu": {"source": "self_declare", "origin": True},
        },
    }
    # 缺 fileList → 官方 400，但 platform_fields seam 已通过校验
    status, body = _post_json(f"{url}/postVideo", payload)
    assert status == 400
    assert "文件列表" in body["msg"]


def test_post_video_unknown_platform_field_rejected(
    backend: tuple[str, Path],
) -> None:
    """story #22 / #25：平台字段非法 → 400，明确指出平台 / 字段 / 候选。"""
    url, _ = backend
    payload = {
        "fileList": ["a.mp4"],
        "accountList": ["a.json"],
        "type": 3,  # 抖音
        "title": "t",
        "platformFields": {
            "douyin": {"declaration": "bogus_value"},
        },
    }
    status, body = _post_json(f"{url}/postVideo", payload)
    assert status == 400
    # 错误信息应同时指出平台 + 字段名 + 候选集合
    msg = body["msg"]
    assert "douyin" in msg or "字段" in msg
    assert "bogus_value" in msg


def test_post_video_unknown_platform_subkey_rejected(
    backend: tuple[str, Path],
) -> None:
    """抖音不接受 origin（小红书/视频号才有）→ 400。"""
    url, _ = backend
    payload = {
        "fileList": ["a.mp4"],
        "accountList": ["a.json"],
        "type": 3,  # 抖音
        "title": "t",
        "platformFields": {
            "douyin": {"origin": True},  # 抖音不支持 origin
        },
    }
    status, body = _post_json(f"{url}/postVideo", payload)
    assert status == 400
    assert "douyin" in body["msg"] or "origin" in body["msg"]


def test_post_video_batch_with_platform_fields_validated(
    backend: tuple[str, Path],
) -> None:
    """/postVideoBatch 接受 platform_fields 数组；任一项非法 → 整批 400。"""
    url, _ = backend
    payload = [
        {
            "fileList": ["a.mp4"],
            "accountList": ["a.json"],
            "type": 3,
            "title": "t",
            "platformFields": {"douyin": {"declaration": "no_need"}},
        },
        {
            "fileList": ["b.mp4"],
            "accountList": ["b.json"],
            "type": 3,
            "title": "u",
            "platformFields": {"douyin": {"declaration": "bogus"}},
        },
    ]
    status, body = _post_json(f"{url}/postVideoBatch", payload)
    assert status == 400
    assert "bogus" in body["msg"]


def test_update_account_defaults_roundtrip(
    backend: tuple[str, Path],
) -> None:
    """/updateAccountDefaults 持久化后 /getAccountDefaults 立即可见。"""
    url, base = backend
    db_path = Path(base) / "db" / "database.db"
    # 注入一个测试账号
    cookie_file = "test_default.json"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO user_info (type, filePath, userName) VALUES (3, ?, '测试号')",
            (cookie_file,),
        )
        conn.commit()
        row_id = conn.execute(
            "SELECT id FROM user_info WHERE filePath = ?", (cookie_file,)
        ).fetchone()[0]

    # 写默认声明
    payload = {
        "id": row_id,
        "default_platform_fields": {"douyin": {"declaration": "no_need"}},
    }
    status, body = _post_json(f"{url}/updateAccountDefaults", payload)
    assert status == 200
    assert body["code"] == 200

    # 读回
    _, body = _get(f"{url}/getAccountDefaults")
    assert body["data"][cookie_file]["douyin"]["declaration"] == "no_need"

    # 清除
    status, _ = _post_json(
        f"{url}/updateAccountDefaults",
        {"id": row_id, "default_platform_fields": None},
    )
    assert status == 200
    _, body = _get(f"{url}/getAccountDefaults")
    assert cookie_file not in body["data"] or body["data"][cookie_file] is None


def test_upload_getfiles_delete_chain(backend: tuple[str, Path]) -> None:
    """素材链往返：/uploadSave → /getFiles 可见 → /deleteFile 移除。"""
    url, _ = backend
    filename, content = "demo.mp4", b"hello smoke"
    status, body = _multipart_upload(f"{url}/uploadSave", filename, content)
    assert status == 200
    assert body["code"] == 200
    stored = body["data"]["filepath"]

    _, files_body = _get(f"{url}/getFiles")
    files = files_body["data"]
    assert any(r["file_path"] == stored for r in files), "上传后 getFiles 应含记录"

    rec = next(r for r in files if r["file_path"] == stored)
    status, dbody = _get(f"{url}/deleteFile?id={rec['id']}")
    assert status == 200
    assert dbody["code"] == 200

    _, files_after_body = _get(f"{url}/getFiles")
    files_after = files_after_body["data"]
    assert all(r["file_path"] != stored for r in files_after), "删除后记录应消失"
