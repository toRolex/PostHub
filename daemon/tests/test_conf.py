"""conf 模块测试：6 个上游依赖符号 + 字段校验。"""

from __future__ import annotations

from pathlib import Path

import pytest

import conf


def test_exposes_six_required_symbols() -> None:
    for name in (
        "BASE_DIR",
        "DEBUG_MODE",
        "LOCAL_CHROME_HEADLESS",
        "LOCAL_CHROME_PATH",
        "XHS_SERVER",
        "YT_PROXY",
    ):
        assert hasattr(conf, name), f"conf 缺少符号 {name}"


def test_default_conf_types() -> None:
    c = conf.load_conf()
    assert isinstance(c.BASE_DIR, Path)
    assert isinstance(c.DEBUG_MODE, bool)
    assert isinstance(c.LOCAL_CHROME_HEADLESS, bool)
    assert isinstance(c.LOCAL_CHROME_PATH, str)
    assert isinstance(c.XHS_SERVER, str)
    assert isinstance(c.YT_PROXY, str)


def test_defaults_are_valid() -> None:
    c = conf.load_conf()
    assert conf.validate(c) == []


def test_env_override(tmp_path) -> None:
    env = {
        "POSTHUB_BASE_DIR": str(tmp_path),
        "POSTHUB_DEBUG_MODE": "true",
        "POSTHUB_LOCAL_CHROME_HEADLESS": "false",
        "POSTHUB_LOCAL_CHROME_PATH": "/usr/bin/google-chrome",
        "POSTHUB_XHS_SERVER": "http://127.0.0.1:8600",
        "POSTHUB_YT_PROXY": "",
    }
    c = conf.load_conf(env)
    assert c.BASE_DIR == tmp_path
    assert c.DEBUG_MODE is True
    assert c.LOCAL_CHROME_HEADLESS is False
    assert c.LOCAL_CHROME_PATH == "/usr/bin/google-chrome"
    assert c.XHS_SERVER == "http://127.0.0.1:8600"
    assert c.YT_PROXY == ""


def test_invalid_xhs_server_rejected(tmp_path) -> None:
    env = {"POSTHUB_BASE_DIR": str(tmp_path), "POSTHUB_XHS_SERVER": "not-a-url"}
    with pytest.raises(conf.ConfValidationError):
        conf.load_conf(env)


def test_invalid_base_dir_rejected() -> None:
    env = {
        "POSTHUB_BASE_DIR": "/definitely/not/exists/posthub",
        "POSTHUB_XHS_SERVER": "http://127.0.0.1:8600",
    }
    with pytest.raises(conf.ConfValidationError):
        conf.load_conf(env)


def test_invalid_bool_rejected(tmp_path) -> None:
    env = {
        "POSTHUB_BASE_DIR": str(tmp_path),
        "POSTHUB_XHS_SERVER": "http://127.0.0.1:8600",
        "POSTHUB_DEBUG_MODE": "not-a-bool",
    }
    with pytest.raises(conf.ConfValidationError):
        conf.load_conf(env)
