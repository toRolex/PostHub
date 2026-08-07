"""PostHub 守护进程：本地 HTTP IPC + 健康检查 + 账号管理 + 任务创建 + 人工介入事件。

常驻服务进程，默认监听 `http://127.0.0.1:8756`。前端通过 HTTP 调用：

- `GET  /health`                健康检查
- `GET  /conf`                  上游 conf 六符号
- `GET  /platform-constraints`  平台约束注册表（表单校验引用）
- `GET  /accounts`              账号列表
- `POST /accounts`              添加账号（落库 + 拉起独立 Chrome 扫码）
- `DELETE /accounts/{id}`       删除账号（移除记录 + 尽力清理关联 Chrome）
- `POST /tasks`                 创建发布任务（task + N 个 platform_job 落库）
- `GET  /interventions`         待人工介入事件列表（验证码挂起 / 需重新扫码，issue #21）
- `POST /interventions/{id}/ack` 标记人工介入事件已处理（前端弹窗后调用）

启动方式：`uv run python -m posthub [PORT]`。
"""

from __future__ import annotations

import json
import os
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import conf
from posthub import __version__
from posthub.accounts import (
    AccountConflictError,
    NewAccount,
    SqliteAccountStore,
    default_db_path,
    default_profile_dir,
    now_str,
)
from posthub.chrome_launcher import ChromeLauncher
from posthub.constraints import PLATFORM_CONSTRAINTS
from posthub.interventions import InMemoryInterventionHub
from posthub.tasks import (
    AccountPlatformMismatchError,
    NewTaskSpec,
    PlatformJobSpec,
    SqliteTaskStore,
    TaskValidationError,
    UnknownAccountError,
)

HOST = "127.0.0.1"
DEFAULT_PORT = 8756
PLATFORMS = ("douyin", "xiaohongshu", "wechat")

__all__ = ["HOST", "DEFAULT_PORT", "make_server", "main"]


def _port_free(port: int) -> bool:
    """试探端口是否空闲（可绑定）。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return False
    except OSError:
        return True


class PostHubHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("body 必须是 JSON 对象")
        return parsed

    # ---- GET ----

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": __version__,
                    "port": self.server.server_address[1],
                },
            )
        elif path == "/conf":
            c = conf.load_conf()
            self._send_json(
                200,
                {
                    "BASE_DIR": str(c.BASE_DIR),
                    "DEBUG_MODE": c.DEBUG_MODE,
                    "LOCAL_CHROME_HEADLESS": c.LOCAL_CHROME_HEADLESS,
                    "LOCAL_CHROME_PATH": c.LOCAL_CHROME_PATH,
                    "XHS_SERVER": c.XHS_SERVER,
                    "YT_PROXY": c.YT_PROXY,
                },
            )
        elif path == "/accounts":
            accounts = [a.to_dict() for a in self.server.account_store.list()]
            self._send_json(200, {"accounts": accounts})
        elif path == "/platform-constraints":
            constraints = [c.to_dict() for c in PLATFORM_CONSTRAINTS.values()]
            self._send_json(200, {"constraints": constraints})
        elif path == "/interventions":
            interventions = [i.to_dict() for i in self.server.interventions.pending()]
            self._send_json(200, {"interventions": interventions})
        elif path == "/tasks":
            tasks = [d.to_dict() for d in self.server.task_store.list_tasks()]
            self._send_json(200, {"tasks": tasks})
        else:
            self._send_json(404, {"error": "not found"})

    # ---- POST ----

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/accounts":
            self._handle_create_account()
        elif path == "/tasks":
            self._handle_create_task()
        elif path.startswith("/interventions/"):
            self._handle_ack_intervention(path)
        elif path.startswith("/accounts/"):
            self._handle_account_action(path)
        elif path.startswith("/tasks/"):
            self._handle_task_job_action(path)
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_task_job_action(self, path: str) -> None:
        """POST /tasks/{task_id}/jobs/{job_id}/retry：手动重试终态 job → pending。

        manual / needs_relogin / failed 经人工处理后，用户在任务 UI 点重试，
        复用 #17 `retry_job`（重试次数保留）。
        """
        rest = path[len("/tasks/"):]
        if "/jobs/" not in rest or not rest.endswith("/retry"):
            self._send_json(404, {"error": "not found"})
            return
        raw_task_id, raw_job_id = rest.split("/jobs/", 1)
        raw_job_id = raw_job_id[: -len("/retry")]
        if not raw_task_id.isdigit() or not raw_job_id.isdigit():
            self._send_json(400, {"error": "task_id / job_id 必须是整数"})
            return
        task_id, job_id = int(raw_task_id), int(raw_job_id)
        jobs = self.server.task_store.list_jobs(task_id)
        job = next((j for j in jobs if j.id == job_id), None)
        if job is None:
            self._send_json(404, {"error": "job 不存在"})
            return
        if job.status not in ("failed", "manual", "needs_relogin"):
            self._send_json(
                400,
                {"error": f"只有终态（failed/manual/needs_relogin）job 可手动重试，当前 {job.status}"},
            )
            return
        ok = self.server.task_store.retry_job(job_id, now_str())
        if not ok:
            self._send_json(404, {"error": "job 不存在"})
            return
        self._send_json(200, {"ok": True})

    def _handle_ack_intervention(self, path: str) -> None:
        """POST /interventions/{id}/ack：标记人工介入事件已处理。"""
        prefix = "/interventions/"
        raw_id = path[len(prefix):]
        if not raw_id.endswith("/ack"):
            self._send_json(404, {"error": "not found"})
            return
        raw_id = raw_id[: -len("/ack")]
        if not raw_id.isdigit():
            self._send_json(400, {"error": "intervention id 必须是整数"})
            return
        acked = self.server.interventions.acknowledge(int(raw_id))
        if not acked:
            self._send_json(404, {"error": "intervention 不存在或已处理"})
            return
        self._send_json(200, {"ok": True})

    def _handle_account_action(self, path: str) -> None:
        """POST /accounts/{id}/relogin 或 /accounts/{id}/status：重登引导 + 状态恢复。

        - `/relogin`：拉起该账号 Chrome 引导重新扫码（issue #21 重登提示）。
        - `/status`：body `{"status": "active"|"needs_relogin"|"disabled"}` 更新账号状态
          （用户重新扫码后恢复可用）。
        """
        rest = path[len("/accounts/"):]
        if "/" not in rest:
            self._send_json(404, {"error": "not found"})
            return
        raw_id, action = rest.split("/", 1)
        if not raw_id.isdigit():
            self._send_json(400, {"error": "账号 id 必须是整数"})
            return
        account = self.server.account_store.get(int(raw_id))
        if account is None:
            self._send_json(404, {"error": "账号不存在"})
            return
        if action == "relogin":
            launch_warning: str | None = None
            try:
                self.server.chrome_launcher.launch(
                    platform=account.platform,
                    profile_dir=account.profile_dir,
                    cdp_port=account.cdp_port,
                )
            except Exception as exc:  # Chrome 未安装等：可稍后重试拉起
                launch_warning = str(exc)
            payload: dict[str, Any] = {"ok": True}
            if launch_warning:
                payload["launch_warning"] = launch_warning
            self._send_json(200, payload)
            return
        if action == "status":
            try:
                body = self._read_json_body()
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "请求体必须是合法 JSON 对象"})
                return
            status = body.get("status")
            if status not in ("active", "needs_relogin", "disabled"):
                self._send_json(
                    400,
                    {"error": "status 必须是 active/needs_relogin/disabled"},
                )
                return
            self.server.account_store.set_status(account.id, status)
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not found"})

    def _handle_create_task(self) -> None:
        try:
            body = self._read_json_body()
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "请求体必须是合法 JSON 对象"})
            return

        title = body.get("title")
        if not title or not str(title).strip():
            self._send_json(400, {"error": "标题不能为空"})
            return

        raw_jobs = body.get("jobs")
        if not isinstance(raw_jobs, list) or not raw_jobs:
            self._send_json(400, {"error": "至少选择一个发布平台"})
            return
        jobs: list[PlatformJobSpec] = []
        for item in raw_jobs:
            platform = item.get("platform")
            account_id = item.get("account_id")
            if platform not in PLATFORM_CONSTRAINTS:
                self._send_json(
                    400,
                    {"error": f"platform 必须是 douyin/xiaohongshu/wechat，收到 {platform!r}"},
                )
                return
            if isinstance(account_id, bool) or not isinstance(account_id, int):
                self._send_json(400, {"error": "account_id 必须是整数"})
                return
            jobs.append(PlatformJobSpec(platform=platform, account_id=account_id))

        media_type = body.get("media_type", "video")
        if media_type not in ("video", "note"):
            self._send_json(400, {"error": f"media_type 必须是 video/note，收到 {media_type!r}"})
            return
        schedule_policy = body.get("schedule_policy", "immediate")
        if schedule_policy not in ("immediate", "scheduled"):
            self._send_json(400, {"error": f"schedule_policy 必须是 immediate/scheduled，收到 {schedule_policy!r}"})
            return
        publish_mode = body.get("publish_mode", "platform_time")
        if publish_mode not in ("platform_time", "local_time"):
            self._send_json(400, {"error": f"publish_mode 必须是 platform_time/local_time，收到 {publish_mode!r}"})
            return

        silent_raw = body.get("silent", False)
        new = NewTaskSpec(
            title=str(title).strip(),
            video_path=body.get("video_path"),
            caption=body.get("caption"),
            tags=body.get("tags"),
            cover_horizontal=body.get("cover_horizontal"),
            cover_vertical=body.get("cover_vertical"),
            media_type=media_type,
            image_paths=body.get("image_paths"),
            schedule_policy=schedule_policy,
            publish_mode=publish_mode,
            publish_at=body.get("publish_at"),
            silent=bool(silent_raw),
            jobs=jobs,
        )
        try:
            task, task_jobs = self.server.task_store.create_task(new)
        except TaskValidationError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        except UnknownAccountError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        except AccountPlatformMismatchError as exc:
            self._send_json(400, {"error": str(exc)})
            return

        self._send_json(
            201,
            {
                "task": task.to_dict(),
                "jobs": [j.to_dict() for j in task_jobs],
            },
        )

    def _handle_create_account(self) -> None:
        try:
            body = self._read_json_body()
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "请求体必须是合法 JSON 对象"})
            return

        platform = body.get("platform")
        if platform not in PLATFORMS:
            self._send_json(
                400,
                {"error": f"platform 必须是 douyin/xiaohongshu/wechat，收到 {platform!r}"},
            )
            return

        name = body.get("name") or platform

        cdp_port = body.get("cdp_port")
        if cdp_port is not None:
            if (
                isinstance(cdp_port, bool)
                or not isinstance(cdp_port, int)
                or not (1024 <= cdp_port <= 65535)
            ):
                self._send_json(
                    400,
                    {"error": "cdp_port 必须是 1024~65535 的整数"},
                )
                return
        else:
            try:
                cdp_port = self._allocate_cdp_port()
            except ValueError as exc:
                self._send_json(503, {"error": str(exc)})
                return

        profile_dir = os.path.join(
            self.server.profile_base_dir, f"{platform}-{cdp_port}"
        )
        new = NewAccount(
            platform=platform,
            name=str(name),
            profile_dir=profile_dir,
            cdp_port=cdp_port,
        )
        try:
            account = self.server.account_store.create(new)
        except AccountConflictError as exc:
            self._send_json(409, {"error": str(exc)})
            return

        launch_warning: str | None = None
        try:
            self.server.chrome_launcher.launch(
                platform=account.platform,
                profile_dir=account.profile_dir,
                cdp_port=account.cdp_port,
            )
        except Exception as exc:  # Chrome 未安装等：账号已落库，可稍后重试拉起
            launch_warning = str(exc)

        payload = account.to_dict()
        if launch_warning:
            payload["launch_warning"] = launch_warning
        self._send_json(201, {"account": payload})

    def _allocate_cdp_port(self) -> int:
        used = {a.cdp_port for a in self.server.account_store.list()}
        for port in range(9222, 9222 + 500):
            if port in used:
                continue
            if _port_free(port):
                return port
        raise ValueError("无可用调试端口")

    # ---- DELETE ----

    def do_DELETE(self) -> None:
        path = self.path.split("?", 1)[0]
        prefix = "/accounts/"
        if path.startswith(prefix):
            raw_id = path[len(prefix):]
            if not raw_id.isdigit():
                self._send_json(400, {"error": "账号 id 必须是整数"})
                return
            account = self.server.account_store.get(int(raw_id))
            if account is None:
                self._send_json(404, {"error": "账号不存在"})
                return
            self.server.account_store.delete(account.id)
            try:
                self.server.chrome_launcher.kill_by_profile_dir(account.profile_dir)
            except Exception:
                pass  # 尽力清理，失败不影响删除
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        # 静默访问日志，避免污染 stdout
        return


def make_server(
    port: int = 0,
    *,
    store=None,
    launcher=None,
    profile_base_dir: str | None = None,
    task_store=None,
    interventions=None,
) -> ThreadingHTTPServer:
    """创建守护进程 HTTP 服务。port=0 时由系统分配端口（测试用）。

    依赖注入：`store`（账号存储）、`launcher`（Chrome 拉起器）、`task_store`
    （任务存储）、`interventions`（人工介入事件 hub，issue #21）供测试替换；
    缺省时使用 SQLite 持久化 + 真实 Chrome 拉起器 + 内存事件 hub。
    """
    httpd = ThreadingHTTPServer((HOST, port), PostHubHandler)
    httpd.account_store = store or SqliteAccountStore(default_db_path())
    httpd.chrome_launcher = launcher or ChromeLauncher()
    httpd.profile_base_dir = profile_base_dir or default_profile_dir()
    httpd.task_store = task_store or SqliteTaskStore(
        default_db_path(), httpd.account_store
    )
    httpd.interventions = interventions or InMemoryInterventionHub()
    return httpd


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(argv[0]) if argv else DEFAULT_PORT
    httpd = make_server(port)
    actual_port = httpd.server_address[1]
    print(f"[posthub-daemon] listening on http://{HOST}:{actual_port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
