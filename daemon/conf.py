"""conf 模块：PostHub 自备的上游依赖配置（ADR-0001 / T1）。

上游 social-auto-upload 执行 `import conf` 并读取以下 6 个符号，否则 import 即崩：

    BASE_DIR / DEBUG_MODE / LOCAL_CHROME_HEADLESS / LOCAL_CHROME_PATH / XHS_SERVER / YT_PROXY

本模块 import 时从环境变量（`POSTHUB_` 前缀）加载并校验；也提供 `load_conf(env)` 供测试注入。
字段校验：BASE_DIR 必须为存在的目录；布尔字段必须可解析；URL 字段必须为合法 http(s) URL。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse

__all__ = [
    "Conf",
    "ConfValidationError",
    "load_conf",
    "validate",
    "BASE_DIR",
    "DEBUG_MODE",
    "LOCAL_CHROME_HEADLESS",
    "LOCAL_CHROME_PATH",
    "XHS_SERVER",
    "YT_PROXY",
]


class ConfValidationError(ValueError):
    """配置校验失败。"""


@dataclass(frozen=True)
class Conf:
    """6 个上游依赖配置字段（ADR-0001）。构造时即校验。

    `BASE_DIR` 用 `pathlib.Path`：上游 `uploader/*/__init__.py` 执行
    `Path(BASE_DIR / "cookies").mkdir(...)`，str 无法做 `/` 运算。
    """

    BASE_DIR: Path
    DEBUG_MODE: bool
    LOCAL_CHROME_HEADLESS: bool
    LOCAL_CHROME_PATH: str
    XHS_SERVER: str
    YT_PROXY: str

    def __post_init__(self) -> None:
        errors = validate(self)
        if errors:
            raise ConfValidationError("; ".join(errors))


def _default_base_dir() -> Path:
    """默认 BASE_DIR 指向仓库 daemon 目录（本文件所在目录）。"""
    return Path(__file__).resolve().parent


def _parse_bool(raw: str) -> bool:
    lowered = raw.strip().lower()
    if lowered in ("1", "true", "yes", "on"):
        return True
    if lowered in ("0", "false", "no", "off"):
        return False
    raise ConfValidationError(f"无法解析布尔值: {raw!r}")


def _valid_http_url(raw: str) -> bool:
    if not raw:
        return False
    try:
        parts = urlparse(raw)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def load_conf(env: Mapping[str, str] | None = None) -> Conf:
    """从环境变量加载并校验配置。env 为 None 时读 os.environ。"""
    values: Mapping[str, str] = os.environ if env is None else env

    def get(key: str, default: str) -> str:
        v = values.get(f"POSTHUB_{key}")
        return v if v is not None else default

    return Conf(
        BASE_DIR=Path(get("BASE_DIR", _default_base_dir())),
        DEBUG_MODE=_parse_bool(get("DEBUG_MODE", "true")),
        LOCAL_CHROME_HEADLESS=_parse_bool(get("LOCAL_CHROME_HEADLESS", "false")),
        LOCAL_CHROME_PATH=get("LOCAL_CHROME_PATH", ""),
        XHS_SERVER=get("XHS_SERVER", "http://127.0.0.1:8600"),
        YT_PROXY=get("YT_PROXY", ""),
    )


def validate(conf: Conf) -> list[str]:
    """返回校验错误列表；为空表示配置合法。"""
    errors: list[str] = []

    if not isinstance(conf.BASE_DIR, Path) or not str(conf.BASE_DIR):
        errors.append("BASE_DIR 必须是非空路径")
    elif not conf.BASE_DIR.is_dir():
        errors.append(f"BASE_DIR 目录不存在: {conf.BASE_DIR}")

    if not isinstance(conf.DEBUG_MODE, bool):
        errors.append("DEBUG_MODE 必须是布尔值")

    if not isinstance(conf.LOCAL_CHROME_HEADLESS, bool):
        errors.append("LOCAL_CHROME_HEADLESS 必须是布尔值")

    if not isinstance(conf.LOCAL_CHROME_PATH, str):
        errors.append("LOCAL_CHROME_PATH 必须是字符串")
    elif conf.LOCAL_CHROME_PATH and "\x00" in conf.LOCAL_CHROME_PATH:
        errors.append("LOCAL_CHROME_PATH 含非法字符")

    if not isinstance(conf.XHS_SERVER, str) or not _valid_http_url(conf.XHS_SERVER):
        errors.append(f"XHS_SERVER 必须是 http(s) URL: {conf.XHS_SERVER!r}")

    if not isinstance(conf.YT_PROXY, str):
        errors.append("YT_PROXY 必须是字符串")
    elif conf.YT_PROXY and not _valid_http_url(conf.YT_PROXY):
        errors.append(f"YT_PROXY 必须是 http(s) URL: {conf.YT_PROXY!r}")

    return errors


def _refresh_module_symbols() -> None:
    """import 时按环境变量刷新模块级 6 符号，保证 `conf.BASE_DIR` 等可用。"""
    c = load_conf()
    globals().update(
        BASE_DIR=c.BASE_DIR,
        DEBUG_MODE=c.DEBUG_MODE,
        LOCAL_CHROME_HEADLESS=c.LOCAL_CHROME_HEADLESS,
        LOCAL_CHROME_PATH=c.LOCAL_CHROME_PATH,
        XHS_SERVER=c.XHS_SERVER,
        YT_PROXY=c.YT_PROXY,
    )


_refresh_module_symbols()
