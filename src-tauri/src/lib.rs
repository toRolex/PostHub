//! PostHub Tauri 2 桌面壳：Windows 托盘 / macOS 菜单栏常驻 + 一键退出 + 开机自启 + 拉起 Python 守护进程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent,
};

/// 守护进程健康检查地址（与 daemon/posthub/server.py 的 DEFAULT_PORT 保持一致）。
pub const DAEMON_URL: &str = "http://127.0.0.1:8756";

/// 守护进程句柄：应用退出时一并结束子进程。
struct DaemonGuard(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(DaemonGuard(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_daemon_url,
            get_autostart,
            set_autostart,
            show_intervention_dialog
        ])
        .setup(|app| {
            build_tray(app)?;
            spawn_daemon(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗口仅隐藏，应用常驻托盘 / 菜单栏；「退出 PostHub」才真正退出。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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

/// 构建托盘 / 菜单栏：显示主窗口 + 一键退出。
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "显示 PostHub", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出 PostHub", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1));

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// 解析守护进程目录：env `POSTHUB_DAEMON_DIR` 优先，否则 `CARGO_MANIFEST_DIR` 的父目录下的 `daemon/`。
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
/// `app_data/ms-playwright` 后通过 PLAYWRIGHT_BROWSERS_PATH 指过去，daemon 不再联网下浏览器。
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

/// 拉起 Python 守护进程（uv 管理，`uv run --project <daemon> python -m posthub`）。
///
/// 解析顺序：env `POSTHUB_DAEMON_DIR` → 安装包内置 resources → 仓库 `daemon/`（dev）。
/// 命令：env `POSTHUB_DAEMON_CMD` 覆盖 → 内置 uv → 系统 `uv`。
/// 使用内置 uv 时，资源目录只读（/Applications、Program Files），venv 建在可写的
/// `app_data_dir()`，通过 `UV_PROJECT_ENVIRONMENT` 指定，避免写资源目录。
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
        eprintln!("[posthub] 未找到 daemon 目录，跳过守护进程拉起");
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
    // 同时补上 daemon 失败原因不可见的缺陷。
    redirect_daemon_log(&app, &mut cmd);
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
            "python",
            "-m",
            "posthub",
        ])
        .current_dir(&daemon_dir)
        .spawn();

    match result {
        Ok(child) => {
            let guard = app.state::<DaemonGuard>();
            if let Ok(mut g) = guard.0.lock() {
                *g = Some(child);
            }
            eprintln!("[posthub] 守护进程已拉起: {}", daemon_dir.display());
        }
        Err(e) => eprintln!("[posthub] 拉起守护进程失败: {e}"),
    }
}

/// 将守护进程子进程的 stdin/stdout/stderr 全量重定向到 app_data/daemon.log。
///
/// Windows GUI 进程 spawn 的子进程若继承 stdout/stderr，会新建控制台窗口承载它们（每次
/// 打开 PostHub 弹终端）。日志落盘同时让 daemon 失败原因可见。app_data 不可用或打开失败
/// 时退化为丢弃输出，保证不弹窗。
fn redirect_daemon_log(app: &AppHandle, cmd: &mut Command) {
    let log = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("daemon.log"))
        .and_then(|p| {
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

#[tauri::command]
fn get_daemon_url() -> String {
    DAEMON_URL.to_string()
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 人工介入弹窗（issue #21）：验证码挂起 / 需重新扫码 时由前端 invoke。
///
/// `kind` 为 `manual`（需人工）或 `needs_relogin`（需重新扫码），决定弹窗类型。
/// 使用 `tauri-plugin-dialog` 的原生消息框；用户点「知道了」关闭。
#[tauri::command]
fn show_intervention_dialog(
    app: AppHandle,
    title: String,
    message: String,
    kind: String,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let dialog_kind = if kind == "needs_relogin" {
        MessageDialogKind::Error
    } else {
        MessageDialogKind::Warning
    };
    app.dialog()
        .message(message)
        .title(title)
        .kind(dialog_kind)
        .show(|_| {});
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
