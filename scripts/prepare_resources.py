#!/usr/bin/env python3
"""Staging daemon 源码 + 下载当前平台 uv 二进制，供 Tauri bundle.resources 打包。

用法: uv run --project daemon python scripts/prepare_resources.py [--os darwin|windows] [--arch arm64|x86_64]
产物:
  src-tauri/resources/daemon/   源码（排除 .venv/__pycache__/cookies/logs 等）
  src-tauri/resources/bin/uv-<os>-<arch>   平台 uv 单二进制
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "src-tauri" / "resources"
DAEMON_DST = RESOURCES / "daemon"
BIN_DST = RESOURCES / "bin"

# Windows CI 控制台默认 cp1252，强制 UTF-8 输出避免中文 print 编码错误
reconfigure = getattr(sys.stdout, "reconfigure", None)
if reconfigure is not None:
    reconfigure(encoding="utf-8")

EXCLUDE = {
    ".venv",
    "__pycache__",
    "cookies",
    "logs",
    ".ruff_cache",
    ".pytest_cache",
    ".mypy_cache",
}

UV_URLS = {
    ("darwin", "arm64"): "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
    ("darwin", "x86_64"): "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
    # Windows 发布为 zip
    ("windows", "x86_64"): "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
}


def detect_os_arch(args: argparse.Namespace) -> tuple[str, str]:
    os_name = args.os or ("darwin" if platform.system() == "Darwin" else "windows")
    machine = platform.machine().lower()
    arch = args.arch or ("arm64" if machine in ("arm64", "aarch64") else "x86_64")
    return os_name, arch


def stage_daemon() -> None:
    src = ROOT / "daemon"
    if DAEMON_DST.exists():
        shutil.rmtree(DAEMON_DST)
    shutil.copytree(src, DAEMON_DST, ignore=shutil.ignore_patterns(*EXCLUDE))
    print(f"[resources] daemon 源码 -> {DAEMON_DST}")


def _download(url: str, dest: Path, retries: int = 4) -> None:
    """下载文件并带重试；GitHub 大文件在 CI 偶发断连（empty reply/Peer disconnected）。"""
    for attempt in range(1, retries + 1):
        r = subprocess.run(
            [
                "curl",
                "-sL",
                "--http1.1",
                "--retry",
                "5",
                "--retry-all-errors",
                "--retry-delay",
                "3",
                "-o",
                str(dest),
                url,
            ],
            capture_output=True,
        )
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
            return
        if attempt == retries:
            raise RuntimeError(f"下载失败（curl exit {r.returncode}）: {url}")
        print(f"[resources] 下载失败，第 {attempt}/{retries} 次重试...")
        time.sleep(3)


def _extract_uv(archive: Path, target: str) -> bytes:
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as zf:
            member = next(n for n in zf.namelist() if n.endswith(target))
            return zf.read(member)
    with tarfile.open(archive) as tar:
        member = next(m for m in tar.getmembers() if m.isfile() and Path(m.name).name == target)
        extracted = tar.extractfile(member)
        if extracted is None:
            raise RuntimeError(f"无法读取 {member.name}")
        return extracted.read()


def fetch_uv(os_name: str, arch: str) -> Path:
    bin_name = f"uv-{os_name}-{arch}"
    bin_path = BIN_DST / bin_name
    if bin_path.exists():
        print(f"[resources] uv 已存在: {bin_path}")
        return bin_path

    BIN_DST.mkdir(parents=True, exist_ok=True)
    url = UV_URLS[(os_name, arch)]
    print(f"[resources] 下载 uv: {url}")
    exe = ".exe" if os_name == "windows" else ""
    target = f"uv{exe}"
    suffix = ".zip" if url.endswith(".zip") else ".tar.gz"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        _download(url, tmp_path)
        data = _extract_uv(tmp_path, target)
    finally:
        tmp_path.unlink(missing_ok=True)

    bin_path.write_bytes(data)
    bin_path.chmod(0o755)
    print(f"[resources] uv -> {bin_path}")
    return bin_path


# ---- Windows 首次启动修复（issue：daemon 未连接）----
# 真实用户网络经代理拉 GitHub git 源 / patchright 海外 CDN 不可靠（测试机实测：
# git TLS 断连、chromium 传输 early EOF）。构建期在 CI（网络稳定）把这两项固化为
# 本地资源随包分发：social-auto-upload → 本地 wheel；patchright Chromium → resources/browser。
# 运行时只从 PyPI 镜像装 patchright 等，首次启动零海外网络。mac 保持源码+uv 现状。

SAU_REPO = "https://github.com/dreammis/social-auto-upload.git"


def build_upstream_wheel(uv_bin: Path) -> Path:
    """clone 上游 social-auto-upload 并 uv build 成本地 wheel（仅 Windows）。

    仓库根 daemon/pyproject.toml 的 git 源不动（mac 开发链路不变），只有随包分发的
    staged 副本改引本地 wheel（rewrite_staged_pyproject）。
    """
    wheel_dir = DAEMON_DST / "wheels"
    wheel_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="sau-build-"))
    try:
        clone = subprocess.run(
            ["git", "clone", "--depth", "1", SAU_REPO, str(tmp / "sau")],
            capture_output=True, text=True,
        )
        if clone.returncode != 0:
            raise RuntimeError(f"clone 上游失败: {clone.stderr[-500:]}")
        build = subprocess.run(
            [str(uv_bin), "build", "--project", str(tmp / "sau"), "--out-dir", str(wheel_dir)],
            capture_output=True, text=True,
        )
        if build.returncode != 0:
            raise RuntimeError(f"uv build 失败: {build.stderr[-500:]}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    wheels = sorted(wheel_dir.glob("social_auto_upload-*.whl"))
    if not wheels:
        raise RuntimeError("构建后未找到 social_auto_upload wheel")
    print(f"[resources] social-auto-upload wheel -> {wheels[-1].name}")
    return wheels[-1]


def fetch_chromium(uv_bin: Path) -> None:
    """用 patchright + playwright CLI 预下载 Chromium（revision 与依赖版本匹配）到 resources/browser。

    必须在目标 OS 的 runner 上执行：浏览器二进制平台相关，CI windows-latest 得到 win64 版。
    通过 PLAYWRIGHT_BROWSERS_PATH 把输出收敛到临时目录，再复制 chromium-*/ 到 resources/browser。

    两个浏览器缺一不可——上传链路用 patchright（chromium-1208），登录链路
    `myUtils/login.py` 用 playwright（chromium-1169）；只打包一个会让另一条链的
    `launch()` 找不到浏览器而崩（#xx：登录二维码出不来的根因之一）。
    """
    # (库版本, CLI 名)：CLI 名即 `uv tool run --from <spec> <cli> install chromium`。
    # 版本必须与 daemon 依赖锁定一致（uv.lock），否则下载的 revision 对不上代码。
    specs = [
        ("patchright==1.58.2", "patchright"),
        ("playwright==1.52.0", "playwright"),
    ]
    if any((RESOURCES / "browser").glob("chromium-*")):
        print("[resources] chromium 已存在，跳过")
        return
    with tempfile.TemporaryDirectory() as tmpd:
        env = dict(os.environ)
        env["PLAYWRIGHT_BROWSERS_PATH"] = tmpd
        for spec, cli in specs:
            r = subprocess.run(
                [str(uv_bin), "tool", "run", "--from", spec, cli, "install", "chromium"],
                capture_output=True, text=True, env=env, timeout=900,
            )
            if r.returncode != 0:
                raise RuntimeError(f"{cli} install chromium 失败: {r.stderr[-500:]}")
        for d in Path(tmpd).glob("chromium-*"):
            shutil.copytree(d, RESOURCES / "browser" / d.name, dirs_exist_ok=True)
    print(f"[resources] chromium -> {RESOURCES / 'browser'}")


def rewrite_staged_pyproject(uv_bin: Path, wheel: Path) -> None:
    """把 staged daemon pyproject 的 git 源改为本地 wheel 引用，并重锁 uv.lock。

    只改 resources/daemon（随包分发的副本）；仓库根 daemon/pyproject.toml 保持 git 源，
    mac 开发链路与 mac 打包不受影响。
    """
    pp = DAEMON_DST / "pyproject.toml"
    text = pp.read_text(encoding="utf-8")
    old = 'social-auto-upload = { git = "https://github.com/dreammis/social-auto-upload.git" }'
    new = f'social-auto-upload = {{ path = "{wheel.relative_to(DAEMON_DST).as_posix()}" }}'
    if old not in text:
        raise RuntimeError(f"staged pyproject 未找到 git 源行: {old}")
    pp.write_text(text.replace(old, new), encoding="utf-8")
    lock = subprocess.run(
        [str(uv_bin), "lock", "--project", str(DAEMON_DST)],
        capture_output=True, text=True,
    )
    if lock.returncode != 0:
        raise RuntimeError(f"uv lock 失败: {lock.stderr[-500:]}")
    print("[resources] staged pyproject 已改 path source + 重锁 uv.lock")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--os", choices=["darwin", "windows"])
    parser.add_argument("--arch", choices=["arm64", "x86_64"])
    args = parser.parse_args()

    os_name, arch = detect_os_arch(args)
    if (os_name, arch) not in UV_URLS:
        print(f"不支持的平台组合: {os_name}/{arch}", file=sys.stderr)
        return 1

    stage_daemon()
    # browser 目录随 tauri.conf.json bundle.resources 引用，需恒存在（mac 为空目录）
    (RESOURCES / "browser").mkdir(parents=True, exist_ok=True)
    uv_bin = fetch_uv(os_name, arch)
    if os_name == "windows":
        wheel = build_upstream_wheel(uv_bin)
        rewrite_staged_pyproject(uv_bin, wheel)
        fetch_chromium(uv_bin)
    print("[resources] 完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
