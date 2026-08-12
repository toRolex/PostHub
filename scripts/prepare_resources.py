#!/usr/bin/env python3
"""Staging daemon 源码 + 下载当前平台 uv 二进制，供 Tauri bundle.resources 打包。

用法: uv run --project daemon python scripts/prepare_resources.py [--os darwin|windows] [--arch arm64|x86_64]
产物:
  src-tauri/resources/daemon/   源码（排除 .venv/__pycache__/cookies/logs 等）
  src-tauri/resources/bin/uv-<os>-<arch>   平台 uv 单二进制
"""
import argparse
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
    """下载文件并带重试；urllib 在 CI 上拉 GitHub 大文件偶发断连，改走系统 curl。"""
    for attempt in range(1, retries + 1):
        r = subprocess.run(
            ["curl", "-sL", "--retry", "3", "-o", str(dest), url],
            capture_output=True,
        )
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
            return
        if attempt == retries:
            raise RuntimeError(f"下载失败（curl exit {r.returncode}）: {url}")
        print(f"[resources] 下载失败，第 {attempt}/{retries} 次重试...")
        time.sleep(2)


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
    fetch_uv(os_name, arch)
    print("[resources] 完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
