"""Chrome 拉起器测试：启动参数 + 可执行路径解析 + 进程拉起 + CDP 端口就绪探测。

验收权衡（issue #15）：真实扫码需人机交互，自动化验证到「Chrome 已拉起、
CDP 端口可连通、扫码引导 UI 出现」即可。本测试用 fake 可执行脚本替代真实 Chrome。
"""

from __future__ import annotations

import os
import socket
import subprocess

import pytest

from posthub.chrome_launcher import (
    ChromeLauncher,
    build_command,
    platform_login_url,
    resolve_chrome_path,
    wait_for_cdp,
)


# ---- build_command：纯函数，给定参数 → 正确启动参数列表 ----

def test_build_command_orders_chrome_first_and_flags() -> None:
    cmd = build_command(
        platform="douyin",
        profile_dir="/tmp/posthub-profile-9222",
        cdp_port=9222,
        chrome_path="/usr/bin/google-chrome",
    )

    assert cmd[0] == "/usr/bin/google-chrome"
    assert "--user-data-dir=/tmp/posthub-profile-9222" in cmd
    assert "--remote-debugging-port=9222" in cmd
    assert "--remote-allow-origins=*" in cmd
    # 最后一个参数是登录引导 URL
    assert cmd[-1] == platform_login_url("douyin")


def test_platform_login_urls() -> None:
    assert platform_login_url("douyin") == "https://www.douyin.com/"
    assert platform_login_url("xiaohongshu") == "https://www.xiaohongshu.com/"
    assert platform_login_url("wechat") == "https://channels.weixin.qq.com/"


# ---- resolve_chrome_path ----

def test_resolve_chrome_path_env_override(monkeypatch, tmp_path) -> None:
    fake = tmp_path / "chrome"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(0o755)
    monkeypatch.setenv("POSTHUB_CHROME_PATH", str(fake))

    assert resolve_chrome_path() == str(fake)


def test_resolve_chrome_path_returns_none_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("POSTHUB_CHROME_PATH", raising=False)
    # 本机可能装有真实 Chrome；这里只验证「未设置时返回路径或 None」，不抛异常
    path = resolve_chrome_path()
    assert path is None or os.path.isfile(path)


# ---- launch：真实拉起（fake 可执行脚本替代 Chrome） ----

def _make_fake_chrome(tmp_path) -> str:
    fake = tmp_path / "fake_chrome"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(0o755)
    return str(fake)


def test_launch_starts_detached_process(tmp_path) -> None:
    launcher = ChromeLauncher()
    proc = launcher.launch(
        platform="douyin",
        profile_dir=str(tmp_path / "profile"),
        cdp_port=9222,
        chrome_path=_make_fake_chrome(tmp_path),
    )
    try:
        assert proc.poll() is None  # 进程仍在运行
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_launch_raises_when_chrome_missing(tmp_path) -> None:
    launcher = ChromeLauncher()
    with pytest.raises(Exception):
        launcher.launch(
            platform="douyin",
            profile_dir=str(tmp_path / "profile"),
            cdp_port=9222,
            chrome_path=str(tmp_path / "not-exists"),
        )


def test_kill_by_profile_dir_terminates_matching_process(tmp_path) -> None:
    if os.name == "nt":
        pytest.skip("Windows 上的按 profile_dir 清理为 no-op")
    profile_dir = str(tmp_path / "profiles" / "douyin-9222")
    launcher = ChromeLauncher()
    proc = launcher.launch(
        platform="douyin",
        profile_dir=profile_dir,
        cdp_port=9222,
        chrome_path=_make_fake_chrome(tmp_path),
    )
    try:
        assert proc.poll() is None
        launcher.kill_by_profile_dir(profile_dir)
        proc.wait(timeout=5)
        assert proc.poll() is not None
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_kill_by_profile_dir_missing_is_noop(tmp_path) -> None:
    launcher = ChromeLauncher()
    launcher.kill_by_profile_dir(str(tmp_path / "no-such-profile"))  # 不应抛异常


# ---- wait_for_cdp：CDP 端口连通性探测 ----

def test_wait_for_cdp_true_when_port_open() -> None:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.listen(1)
        assert wait_for_cdp(port, timeout=1.0) is True
    finally:
        sock.close()


def test_wait_for_cdp_false_when_port_closed() -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    assert wait_for_cdp(port, timeout=0.3) is False
