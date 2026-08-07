"""Chrome 拉起器：为账号拉起独立本机 Chrome 扫码登录。

每账号 = 一台本机 Chrome（独立 `user-data-dir` + 独立调试端口 `cdp_port`），
启动参数必须包含（CONTEXT.md / issue #15）：

    <chrome_path> --user-data-dir=<profile_dir> --remote-debugging-port=<cdp_port>
    --remote-allow-origins=* <平台登录页 URL>

`--remote-allow-origins=*` 使 patchright/playwright 的 `connect_over_cdp` 可接管。
登录态由 `user-data-dir` 持久化，重开应用无需重复扫码（acceptance #15）。
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from typing import Sequence

Platform = str

__all__ = [
    "ChromeNotFoundError",
    "PLATFORM_LOGIN_URLS",
    "platform_login_url",
    "build_command",
    "resolve_chrome_path",
    "launch_chrome",
    "wait_for_cdp",
    "ChromeLauncher",
]

PLATFORM_LOGIN_URLS: dict[Platform, str] = {
    "douyin": "https://www.douyin.com/",
    "xiaohongshu": "https://www.xiaohongshu.com/",
    "wechat": "https://channels.weixin.qq.com/",
}


class ChromeNotFoundError(RuntimeError):
    """找不到 Chrome/Edge 可执行文件。"""


def platform_login_url(platform: str) -> str:
    """平台扫码登录引导页（Chrome 拉起后打开，用户扫码）。"""
    try:
        return PLATFORM_LOGIN_URLS[platform]
    except KeyError as exc:
        raise ValueError(f"未知平台: {platform!r}") from exc


def _well_known_chrome_paths() -> list[str]:
    if sys.platform == "darwin":
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    if os.name == "nt":
        return [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(
                r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
            ),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        ]
    return [shutil.which("google-chrome") or "", shutil.which("chromium") or ""]


def resolve_chrome_path() -> str | None:
    """解析 Chrome/Edge 可执行文件路径：环境变量 → conf → 常见安装路径。"""
    env_path = os.environ.get("POSTHUB_CHROME_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    try:  # conf.LOCAL_CHROME_PATH 可能由上游配置提供（可选）
        import conf

        conf_path = conf.LOCAL_CHROME_PATH
        if conf_path and os.path.isfile(conf_path):
            return conf_path
    except Exception:
        pass

    for candidate in _well_known_chrome_paths():
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def build_command(
    *,
    platform: str,
    profile_dir: str,
    cdp_port: int,
    chrome_path: str,
) -> list[str]:
    """生成 Chrome 启动参数（纯函数，测试直接断言）。"""
    return [
        chrome_path,
        f"--user-data-dir={profile_dir}",
        f"--remote-debugging-port={cdp_port}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        platform_login_url(platform),
    ]


def _popen_detached(cmd: Sequence[str]) -> subprocess.Popen:
    kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(list(cmd), **kwargs)


def launch_chrome(
    *,
    platform: str,
    profile_dir: str,
    cdp_port: int,
    chrome_path: str | None = None,
) -> subprocess.Popen:
    """拉起独立 Chrome 并打开平台登录页。找不到可执行文件时抛 ChromeNotFoundError。"""
    path = chrome_path or resolve_chrome_path()
    if path is None:
        raise ChromeNotFoundError(
            "未找到 Chrome/Edge 可执行文件，请安装 Chrome 或设置 POSTHUB_CHROME_PATH"
        )
    cmd = build_command(
        platform=platform,
        profile_dir=profile_dir,
        cdp_port=cdp_port,
        chrome_path=path,
    )
    return _popen_detached(cmd)


def wait_for_cdp(port: int, timeout: float = 10.0) -> bool:
    """轮询 CDP 调试端口连通性，端口可连返回 True，超时返回 False。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1.0):
                return True
        except OSError:
            time.sleep(0.2)
    return False


class ChromeLauncher:
    """可注入的 Chrome 拉起器（server 依赖注入，测试可替换）。"""

    def __init__(self, chrome_path: str | None = None) -> None:
        self._chrome_path = chrome_path

    def resolve(self) -> str | None:
        if self._chrome_path:
            return self._chrome_path
        return resolve_chrome_path()

    def launch(
        self,
        *,
        platform: str,
        profile_dir: str,
        cdp_port: int,
        chrome_path: str | None = None,
    ) -> subprocess.Popen:
        return launch_chrome(
            platform=platform,
            profile_dir=profile_dir,
            cdp_port=cdp_port,
            chrome_path=chrome_path or self._chrome_path,
        )

    def kill_by_profile_dir(self, profile_dir: str) -> None:
        """尽力清理：按 user-data-dir 匹配并结束该账号的 Chrome（删除账号时调用）。"""
        if os.name == "nt":
            # Windows 下按命令行匹配进程较脆弱，删除账号只移除记录，不强行杀进程。
            return
        try:
            pgrep = subprocess.run(
                ["pgrep", "-f", profile_dir],
                capture_output=True,
                text=True,
                timeout=5,
            )
            pids = [pid for pid in pgrep.stdout.split() if pid.isdigit()]
            if pids:
                subprocess.run(
                    ["kill", *pids], capture_output=True, timeout=5
                )
        except (subprocess.SubprocessError, OSError):
            pass  # 尽力而为：清理失败不影响删除账号

    def wait_for_cdp(self, port: int, timeout: float = 10.0) -> bool:
        return wait_for_cdp(port, timeout)
