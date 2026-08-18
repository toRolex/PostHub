//! PostHub Tauri 2 桌面壳：拉起官方后端（127.0.0.1:5409）、点叉即关（无托盘）。
//!
//! 官方后端即上游 `sau_backend.py`，入口 `daemon/run_backend.py`（launcher，负责
//! 幂等建库 + 仅监听 127.0.0.1）。壳启动时用 uv 拉起子进程并做端口就绪轮询，
//! 退出时确保杀掉子进程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent};

/// 官方后端探活地址（与 daemon/run_backend.py 的监听一致）。
pub const DAEMON_URL: &str = "http://127.0.0.1:5409";
/// 后端端口就绪轮询：每次探活超时、总超时。
const BACKEND_POLL_TIMEOUT: Duration = Duration::from_secs(2);
const BACKEND_POLL_TOTAL: Duration = Duration::from_secs(30);

/// 官方后端子进程句柄：应用退出时一并结束。
struct DaemonGuard(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DaemonGuard(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_daemon_url])
        .setup(|app| {
            spawn_daemon(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running PostHub")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let mut child_to_kill = None;
                if let Ok(mut g) = app.state::<DaemonGuard>().0.lock() {
                    child_to_kill = g.take();
                }
                if let Some(mut child) = child_to_kill {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

/// 解析 daemon 目录：env `POSTHUB_DAEMON_DIR` 优先，否则 `CARGO_MANIFEST_DIR` 的父目录下的 `daemon/`。
fn resolve_daemon_dir(manifest_dir: &str, env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = env_override {
        if !dir.is_empty() {
            let p = PathBuf::from(dir);
            if p.join("pyproject.toml").is_file() {
                return Some(p);
            }
        }
    }
    let repo = Path::new(manifest_dir).parent()?;
    let candidate = repo.join("daemon");
    if candidate.join("pyproject.toml").is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// 内置 daemon 目录：安装包 `bundle.resources` 带进来的源码（含 pyproject.toml）。
/// Tauri v2 把 resources 放在 `<resource_dir>/resources/` 子目录。
/// dev 时资源未打包，`resource_dir()` 下无 daemon → 返回 None，回退仓库路径。
fn resolve_bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    let candidate = app
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("daemon");
    if candidate.join("pyproject.toml").is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// 内置 uv 二进制：按当前平台从 resources/bin 选择，命名见 scripts/prepare_resources.py。
fn resolve_bundled_uv(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "uv-windows-x86_64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "uv-darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "uv-darwin-x86_64"
    } else {
        return None;
    };
    let candidate = app
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("bin")
        .join(name);
    candidate.is_file().then_some(candidate)
}

/// Windows 首次启动修复：把打包的 Chromium 首次复制到可写 app_data，返回 PLAYWRIGHT_BROWSERS_PATH 值。
///
/// patchright wheel 不含浏览器本体，首次 launch 从海外 CDN 下载，经不可靠代理会失败
/// （测试机实测 server closed abruptly）。构建期已用 `patchright install chromium` 把
/// chromium-*/ 打进 resources/browser（prepare_resources.py），这里首次复制到
/// `app_data/ms-playwright` 后通过 PLAYWRIGHT_BROWSERS_PATH 指过去，后端不再联网下浏览器。
/// 资源目录（Program Files）只读，故复制到 app_data；已有则跳过。
#[cfg(target_os = "windows")]
fn prepare_windows_runtime(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let src_browser = app
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("browser");
    if !src_browser.is_dir() {
        return None;
    }
    let dst_browser = app_data.join("ms-playwright");
    if !dst_browser.exists() {
        let _ = copy_dir_all(&src_browser, &dst_browser);
    }
    dst_browser.is_dir().then_some(dst_browser)
}

#[cfg(target_os = "windows")]
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::fs;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 拉起官方后端（uv 管理，`uv run --project <daemon> run_backend.py`）。
///
/// 解析顺序：env `POSTHUB_DAEMON_DIR` → 安装包内置 resources → 仓库 `daemon/`（dev）。
/// 命令：env `POSTHUB_DAEMON_CMD` 覆盖 → 内置 uv → 系统 `uv`。
/// 使用内置 uv 时，资源目录只读（/Applications、Program Files），venv 建在可写的
/// `app_data_dir()`，通过 `UV_PROJECT_ENVIRONMENT` 指定，避免写资源目录。
/// 端口就绪：每 `BACKEND_POLL_TIMEOUT` 探活一次 `127.0.0.1:5409`，最多
/// `BACKEND_POLL_TOTAL`；任何探活异常（子进程早退/连不上）都写 stderr 可见。
fn spawn_daemon(app: AppHandle) {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let env_dir = std::env::var("POSTHUB_DAEMON_DIR")
        .ok()
        .filter(|d| !d.is_empty() && Path::new(d).join("pyproject.toml").is_file());
    let Some(daemon_dir) = env_dir
        .map(PathBuf::from)
        .or_else(|| resolve_bundled_dir(&app))
        .or_else(|| resolve_daemon_dir(manifest_dir, None))
    else {
        eprintln!("[posthub] 未找到 daemon 目录，跳过官方后端拉起");
        return;
    };

    let env_cmd = std::env::var("POSTHUB_DAEMON_CMD").ok().filter(|c| !c.is_empty());
    let bundled_uv = resolve_bundled_uv(&app);
    let (command, use_bundled_venv) = if let Some(c) = env_cmd {
        (c, false)
    } else if let Some(uv) = bundled_uv {
        (uv.display().to_string(), true)
    } else {
        ("uv".to_string(), false)
    };

    let daemon_dir_str = daemon_dir.to_str().unwrap_or(".").to_string();
    let mut cmd = Command::new(&command);
    if use_bundled_venv {
        if let Ok(app_data) = app.path().app_data_dir() {
            cmd.env("UV_PROJECT_ENVIRONMENT", app_data.join("venv"));
            // Windows：隔离 managed Python，绕开 %APPDATA%\uv\python 的不可信 junction（os error 448）
            #[cfg(target_os = "windows")]
            cmd.env("UV_PYTHON_INSTALL_DIR", app_data.join("python"));
        }
    }
    // Windows：预置 Chromium（wheel 不含浏览器，CDN 经代理不可靠），首次启动零海外下载
    #[cfg(target_os = "windows")]
    if let Some(browsers_path) = prepare_windows_runtime(&app) {
        cmd.env("PLAYWRIGHT_BROWSERS_PATH", browsers_path);
    }
    // 子进程 stdio 全量重定向：Windows GUI 进程（posthub.exe）spawn 的子进程若继承
    // stdout/stderr，Windows 会新建控制台窗口承载它们（每次打开弹终端）。重定向到日志文件
    // 同时补上后端失败原因不可见的缺陷。
    redirect_backend_log(&app, &mut cmd);
    // Windows：禁止为子进程创建控制台窗口
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let result = cmd
        .args([
            "run",
            "--project",
            &daemon_dir_str,
            "run_backend.py",
        ])
        .current_dir(&daemon_dir)
        .spawn();

    match result {
        Ok(child) => {
            let guard = app.state::<DaemonGuard>();
            if let Ok(mut g) = guard.0.lock() {
                *g = Some(child);
            }
            eprintln!("[posthub] 官方后端已拉起: {}", daemon_dir.display());
            // 就绪轮询放后台线程，避免在 setup 主线程 sleep 阻塞 UI 首帧。
            let poll_app = app.clone();
            let poll_dir = daemon_dir.clone();
            std::thread::spawn(move || poll_backend_ready(&poll_app, &poll_dir));
        }
        Err(e) => eprintln!("[posthub] 拉起官方后端失败: {e}"),
    }
}

/// 轮询 `127.0.0.1:5409` 直到就绪或超时；失败写 stderr 可见（配合 backend.log 定位原因）。
fn poll_backend_ready(app: &AppHandle, daemon_dir: &Path) {
    let deadline = Instant::now() + BACKEND_POLL_TOTAL;
    loop {
        if Instant::now() >= deadline {
            eprintln!(
                "[posthub] 官方后端 {BACKEND_POLL_TOTAL:?} 内未就绪（探活 {}），详见 {}",
                DAEMON_URL,
                backend_log_path(app)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "app_data 不可用".to_string())
            );
            return;
        }

        let subprocess_exited = {
            let guard = app.state::<DaemonGuard>();
            let mut exited = false;
            if let Ok(mut g) = guard.0.lock() {
                if let Some(child) = g.as_mut() {
                    exited = child.try_wait().ok().flatten().is_some();
                }
            }
            exited
        };
        if subprocess_exited {
            eprintln!(
                "[posthub] 官方后端子进程提前退出，详见 {}",
                backend_log_path(app)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "app_data 不可用".to_string())
            );
            return;
        }

        match probe_backend() {
            Ok(true) => {
                eprintln!("[posthub] 官方后端就绪: {DAEMON_URL}（{}）", daemon_dir.display());
                return;
            }
            Ok(false) => {}
            Err(e) => eprintln!("[posthub] 探活 {DAEMON_URL} 异常: {e}"),
        }
        std::thread::sleep(BACKEND_POLL_TIMEOUT);
    }
}

/// 发起一次探活，返回是否收到 2xx。
///
/// 探 `/getAccounts`（未启用账号校验的真实 API 路由）而非 `/`：官方 Flask 的
/// `/` serve 的是 `sau_frontend` 静态产物（未随 daemon 打包），无此文件会稳定 404，
/// 不能作后端就绪的判断依据。`/getAccounts` 访问 payload 后返回 JSON 200，是
/// 「后端真正可服务」的最小无副作用信号。
fn probe_backend() -> Result<bool, String> {
    let code = ureq::get(&format!("{DAEMON_URL}/getAccounts"))
        .timeout(BACKEND_POLL_TIMEOUT)
        .call()
        .map(|r| r.status())
        .map_err(|e| e.to_string())?;
    Ok((200..300).contains(&code))
}

/// 将官方后端子进程的 stdin/stdout/stderr 全量重定向到 app_data/backend.log。
///
/// Windows GUI 进程 spawn 的子进程若继承 stdout/stderr，会新建控制台窗口承载它们（每次
/// 打开 PostHub 弹终端）。日志落盘同时让后端失败原因可见。app_data 不可用或打开失败时
/// 退化为丢弃输出，保证不弹窗。
fn redirect_backend_log(app: &AppHandle, cmd: &mut Command) {
    let log = backend_log_path(app).and_then(|p| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    });
    let (out, err) = match log {
        Some(log) => match log.try_clone() {
            Ok(err_log) => (Stdio::from(log), Stdio::from(err_log)),
            Err(_) => (Stdio::null(), Stdio::null()),
        },
        None => (Stdio::null(), Stdio::null()),
    };
    cmd.stdin(Stdio::null()).stdout(out).stderr(err);
}

/// 官方后端日志文件路径：`<app_data>/backend.log`。
fn backend_log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("backend.log"))
}

#[tauri::command]
fn get_daemon_url() -> String {
    DAEMON_URL.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_daemon_dir_from_manifest() {
        let repo = std::env::temp_dir().join("posthub-resolve-from-manifest");
        let src_tauri = repo.join("src-tauri");
        let daemon = repo.join("daemon");
        std::fs::create_dir_all(&src_tauri).unwrap();
        std::fs::create_dir_all(&daemon).unwrap();
        std::fs::write(daemon.join("pyproject.toml"), "").unwrap();

        let resolved = resolve_daemon_dir(src_tauri.to_str().unwrap(), None).unwrap();
        assert_eq!(resolved, daemon);

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn env_override_wins_when_valid() {
        let repo = std::env::temp_dir().join("posthub-resolve-override");
        let daemon = repo.join("daemon");
        std::fs::create_dir_all(&daemon).unwrap();
        std::fs::write(daemon.join("pyproject.toml"), "").unwrap();

        let resolved = resolve_daemon_dir("/nonexistent/src-tauri", Some(daemon.to_str().unwrap()))
            .expect("override 目录有效时应命中");
        assert_eq!(resolved, daemon);

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn returns_none_when_missing() {
        let resolved = resolve_daemon_dir("/nonexistent/src-tauri", Some("/nonexistent/daemon"));
        assert!(resolved.is_none());
    }
}
