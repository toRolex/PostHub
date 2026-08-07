//! PostHub Tauri 2 桌面壳：Windows 托盘 / macOS 菜单栏常驻 + 一键退出 + 开机自启 + 拉起 Python 守护进程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
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
        .manage(DaemonGuard(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_daemon_url,
            get_autostart,
            set_autostart
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

/// 拉起 Python 守护进程（uv 管理，`uv run --project <daemon> python -m posthub`）。
fn spawn_daemon(app: AppHandle) {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let env_override = std::env::var("POSTHUB_DAEMON_DIR").ok();
    let Some(daemon_dir) = resolve_daemon_dir(manifest_dir, env_override.as_deref()) else {
        eprintln!("[posthub] 未找到 daemon 目录，跳过守护进程拉起");
        return;
    };

    let command = std::env::var("POSTHUB_DAEMON_CMD").unwrap_or_else(|_| "uv".into());
    let daemon_dir_str = daemon_dir.to_str().unwrap_or(".").to_string();
    let result = Command::new(command)
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
