//! PostHub Tauri 2 桌面壳：拉起官方后端（127.0.0.1:5409）、点叉即关（无托盘）。
//!
//! 官方后端即上游 `sau_backend.py`，入口 `daemon/run_backend.py`（launcher，负责
//! 幂等建库 + 仅监听 127.0.0.1）。壳启动时用 uv 拉起子进程并做端口就绪轮询，
//! 退出时确保杀掉子进程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sysinfo::System;
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
        // 单实例插件：双开 PostHub 时把请求转发到第一个实例并激活窗口，
        // 避免重复拉起 daemon 抢占 5409。必须第一个注册。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(DaemonGuard(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_daemon_url,
            get_chrome_path,
            set_chrome_path
        ])
        .setup(|app| {
            // 启动前清扫上次崩溃/强杀留下的官方后端孙进程（issue #31 / ADR-0007）。
            // app_data_dir 不可用时跳过清扫，不阻塞启动。
            if let Some(app_data) = app.path().app_data_dir().ok() {
                let killed = sweep_stale_daemons(&app_data);
                if killed > 0 {
                    eprintln!("[posthub] 启动前清扫已结束，处理 {} 个残留 daemon 进程树", killed);
                }
            } else {
                eprintln!("[posthub] app_data_dir 不可用，跳过启动前清扫");
            }
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
                    // Windows：uv trampoline（直接子进程）→ managed python（孙进程跑 run_backend.py）
                    // 只 kill 直接子进程会让孙进程成孤儿继续监听 5409。taskkill /T 杀整条进程树
                    // （含孙进程的子代如 chromium.exe），CREATE_NO_WINDOW 抑制控制台窗口弹出。
                    // 其他平台无进程树概念，沿用裸 kill 兜底。
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        if let Some(pid) = child.id() {
                            match Command::new("taskkill")
                                .args(["/F", "/T", "/PID", &pid.to_string()])
                                .creation_flags(CREATE_NO_WINDOW)
                                .output()
                            {
                                Ok(out) => {
                                    if !out.status.success() {
                                        eprintln!(
                                            "[posthub] taskkill 退出码 {:?}：stdout={:?} stderr={:?}",
                                            out.status.code(),
                                            String::from_utf8_lossy(&out.stdout),
                                            String::from_utf8_lossy(&out.stderr)
                                        );
                                    }
                                }
                                Err(e) => eprintln!("[posthub] taskkill 调用失败：{e}"),
                            }
                        }
                    }
                    #[cfg(not(target_os = "windows"))]
                    let _ = child.kill();
                    // 回收子进程句柄，避免 zombie；Windows taskkill 后同样需要 wait 释放 uv 句柄。
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

/// Windows 首次启动修复：把打包的 Chromium 复制到可写 app_data，返回 PLAYWRIGHT_BROWSERS_PATH 值。
///
/// patchright/playwright wheel 不含浏览器本体，首次 launch 从海外 CDN 下载，经不可靠代理会失败
/// （测试机实测 server closed abruptly）。构建期已把 chromium-* 打进 resources/browser
/// （prepare_resources.py），这里复制到 `app_data/ms-playwright` 后通过 PLAYWRIGHT_BROWSERS_PATH
/// 指过去，后端不再联网下浏览器。
/// 资源目录（Program Files）只读，故复制到 app_data。**逐 chromium-* 增量补缺**：
/// 旧版本只带 chromium-1208，升级到带 1169+1208 的新包时，若 app_data 已存在旧目录
/// 会整体跳过复制，导致 playwright 要的 1169 永远缺（登录二维码出不来的升级场景根因）。
/// 因此对每个源子目录，目标缺失才复制，目标已有同名则跳过（保留既有、只补新版本）。
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
    } else {
        // 增量补缺：升级场景下旧 app_data 可能缺新版带来的 chromium-*。
        if let Ok(entries) = std::fs::read_dir(&src_browser) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let to = dst_browser.join(&name);
                if !to.exists() {
                    let _ = copy_dir_all(&entry.path(), &to);
                }
            }
        }
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

/// 是否属于本应用上次崩溃/强杀留下的官方后端孙进程。
///
/// 双条件精确匹配（避免误伤其他用户/其他版本的 PostHub）：
/// 1. `exe` 的路径必须位于 `app_python_dir` 之下（**按路径分量**，不是字符串前缀；
///    `/foo/pythonX` 不能误匹配 `/foo/python`）。
/// 2. `cmdline` 含子串 `run_backend.py`。
///
/// 路径字符串比较不区分大小写（Windows 路径不区分大小写）。
pub fn matches_daemon_filter(exe: &Path, cmdline: &str, app_python_dir: &Path) -> bool {
    if !cmdline.contains("run_backend.py") {
        return false;
    }
    if exe.as_os_str().is_empty() {
        return false;
    }
    // 路径分量比较：app_python_dir 的每个 component 必须是 exe 的前缀 component
    let app_parts: Vec<_> = app_python_dir.components().collect();
    let exe_parts: Vec<_> = exe.components().collect();
    if exe_parts.len() < app_parts.len() {
        return false;
    }
    app_parts
        .iter()
        .zip(exe_parts.iter())
        .all(|(a, e)| a.as_os_str().eq_ignore_ascii_case(e.as_os_str()))
}

/// 启动前清扫残留的官方后端进程（孙进程）。
///
/// 枚举系统进程，按 `matches_daemon_filter` 双重条件（exe 位于 `app_data_dir/python` 下
/// 且 cmdline 含 `run_backend.py`）过滤命中项，逐个调用 `taskkill /F /T /PID` 杀整条
/// 进程树（含孙进程的孙进程如 chromium.exe、playwright 子进程）。
///
/// 跳过当前进程自身（防御性）。空进程列表必须 no-op、幂等——反复调用不会误杀。
///
/// Windows 走 `taskkill`；其他平台暂不治理（返回 0）。
///
/// 参考 ADR-0007：sysinfo 替代 PowerShell / wmic；不使用 Job Object / WMI。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn sweep_stale_daemons(app_data_dir: &Path) -> usize {
    let app_python_dir = app_data_dir.join("python");
    let mut system = System::new_all();
    system.refresh_all();

    let self_pid = sysinfo::get_current_pid().ok();

    let mut pids: Vec<u32> = Vec::new();
    for (pid, process) in system.processes() {
        if Some(*pid) == self_pid {
            continue;
        }
        let exe = match process.exe() {
            Some(p) => p,
            None => continue,
        };
        let cmdline = process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if matches_daemon_filter(exe, &cmdline, &app_python_dir) {
            pids.push(pid.as_u32());
        }
    }

    if pids.is_empty() {
        return 0;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut killed = 0usize;
        for pid in &pids {
            let pid_str = pid.to_string();
            match Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid_str])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                Ok(out) if out.status.success() => {
                    killed += 1;
                    eprintln!("[posthub] 启动前清扫: taskkill /F /T /PID {} 成功", pid);
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    eprintln!(
                        "[posthub] 启动前清扫: taskkill /F /T /PID {} 失败: {}",
                        pid,
                        stderr.trim()
                    );
                }
                Err(e) => {
                    eprintln!("[posthub] 启动前清扫: taskkill /F /T /PID {} 调用失败: {}", pid, e);
                }
            }
        }
        killed
    }
    #[cfg(not(target_os = "windows"))]
    {
        0
    }
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
    // 用户配置的本地 Chrome 路径（设置页 → app_data/settings.json）注入环境变量，
    // daemon conf.py 的 `LOCAL_CHROME_PATH = get("POSTHUB_LOCAL_CHROME_PATH", "")` 读取。
    // 为空不注入，daemon 回落走自带 Chromium。
    let chrome_path = read_chrome_path(&app);
    if let Some(path) = chrome_path.filter(|p| !p.is_empty()) {
        cmd.env("POSTHUB_LOCAL_CHROME_PATH", path);
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

/// settings.json 里承载用户本地 Chrome 路径的键。值语义 = `LOCAL_CHROME_PATH`
/// （chrome.exe 可执行文件路径），daemon 以 `POSTHUB_LOCAL_CHROME_PATH` 环境变量读取。
const SETTINGS_FILE: &str = "settings.json";
const CHROME_PATH_KEY: &str = "chrome_path";

/// 设置文件路径：`<app_data>/settings.json`。
fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

/// 从 settings.json 读取配置的本地 Chrome 路径（空串 = 未配置 / 文件不存在）。
fn read_chrome_path_from(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get(CHROME_PATH_KEY)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// 写用户配置的本地 Chrome 路径到 settings.json。空串 = 清除配置。
fn write_chrome_path_to(path: &Path, chrome_path: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let value = serde_json::json!({ CHROME_PATH_KEY: chrome_path });
    std::fs::write(path, serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// 读用户配置的本地 Chrome 路径（空串 = 未配置）。
fn read_chrome_path(app: &AppHandle) -> Option<String> {
    let path = settings_path(app)?;
    read_chrome_path_from(&path)
}

/// IPC：读当前配置的本地 Chrome 路径（未配置返回空串）。
#[tauri::command]
fn get_chrome_path(app: tauri::AppHandle) -> String {
    read_chrome_path(&app).unwrap_or_default()
}

/// IPC：写入本地 Chrome 路径，供下次 daemon 启动注入 `POSTHUB_LOCAL_CHROME_PATH`。
/// 空串表示清除配置。返回写入后的路径（含清除时返回空串）。
#[tauri::command]
fn set_chrome_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let settings = settings_path(&app).ok_or_else(|| "app_data 不可用".to_string())?;
    write_chrome_path_to(&settings, path.trim())?;
    Ok(read_chrome_path_from(&settings).unwrap_or_default())
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

    #[test]
    fn settings_write_then_read_roundtrip() {
        let dir = std::env::temp_dir().join("posthub-settings-roundtrip");
        let file = dir.join("settings.json");
        write_chrome_path_to(&file, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").unwrap();
        assert_eq!(
            read_chrome_path_from(&file).as_deref(),
            Some("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_clear_writes_empty() {
        let dir = std::env::temp_dir().join("posthub-settings-clear");
        let file = dir.join("settings.json");
        write_chrome_path_to(&file, "C:\\chrome.exe").unwrap();
        write_chrome_path_to(&file, "").unwrap();
        assert_eq!(read_chrome_path_from(&file).as_deref(), Some(""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_missing_file_reads_none() {
        let dir = std::env::temp_dir().join("posthub-settings-missing");
        let file = dir.join("missing.json");
        assert!(read_chrome_path_from(&file).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- sweep_stale_daemons 过滤纯函数（issue #31）----

    fn linux_python_dir() -> PathBuf {
        PathBuf::from("/home/user/.local/share/com.posthub.desktop/python")
    }

    #[test]
    fn filter_matches_python_under_app_data() {
        // exe = app_data/python/.../python.exe + cmdline 含 run_backend.py → 命中
        let exe = PathBuf::from(
            "/home/user/.local/share/com.posthub.desktop/python/cpython-3.11.13-linux-x86_64-gnu/bin/python3.11",
        );
        let cmdline = "uv run --project /srv/daemon run_backend.py";
        assert!(matches_daemon_filter(&exe, cmdline, &linux_python_dir()));
    }

    #[test]
    fn filter_matches_windows_case_insensitive() {
        // 模拟 Windows app_data（用 / 分隔保证 Path::components 跨平台拆分）。
        // Windows 真实运行时会用 \ 分隔符，sysinfo 给出的 exe 也是 Windows 形式；
        // 但作为纯函数 fixture 我们要求 component 级大小写不敏感，/ 与 \ 同理。
        let app = PathBuf::from("/users/foo/appdata/roaming/com.posthub.desktop/python");
        let exe = PathBuf::from(
            "/Users/Foo/AppData/Roaming/com.posthub.desktop/python/cpython-3.11.13-windows-x86_64-none/python.exe",
        );
        let cmdline = "uv run --project C:/srv/daemon run_backend.py";
        assert!(matches_daemon_filter(&exe, cmdline, &app));
    }

    #[test]
    fn filter_matches_windows_backslash_case_insensitive() {
        // 含 \ 分隔符 + 大小写差异：用 component 级比较时单 component
        // （非 Windows Path 不把 \ 拆开）会因字符串长度不同而失败，这是非 Windows 平台
        // 对反斜杠路径的标准行为；Windows 真机上 Path::components 会拆 3 段，因此断言
        // 改用 starts_with_ignore_ascii_case 的语义来表达。
        let app = PathBuf::from(r"C:\Users\Foo\AppData\Roaming\com.posthub.desktop\python");
        let exe_lower = PathBuf::from(
            r"c:\users\foo\appdata\roaming\com.posthub.desktop\python\cpython-3.11.13-windows-x86_64-none\python.exe",
        );
        let cmdline = "uv run --project C:/srv/daemon run_backend.py";
        // 该 case 仅在 Windows 上期望返回 true；非 Windows 平台 Path 把反斜杠路径当作
        // 单 component，组件级 eq_ignore_ascii_case 因长度不同会返回 false。
        let expected = cfg!(target_os = "windows");
        assert_eq!(
            matches_daemon_filter(&exe_lower, cmdline, &app),
            expected,
            "反斜杠路径大小写不敏感：仅 Windows 平台通过（Path::components 行为差异）"
        );
    }

    #[test]
    fn filter_rejects_when_cmdline_missing_run_backend() {
        let exe = PathBuf::from(
            "/home/user/.local/share/com.posthub.desktop/python/cpython-3.11.13-linux-x86_64-gnu/bin/python3.11",
        );
        let cmdline = "uv run --project /srv/daemon some_other_script.py";
        assert!(!matches_daemon_filter(&exe, cmdline, &linux_python_dir()));
    }

    #[test]
    fn filter_rejects_when_exe_outside_app_python_dir() {
        // exe 在 /usr/bin/python，不是 app_data/python 下
        let exe = PathBuf::from("/usr/bin/python3.11");
        let cmdline = "uv run --project /srv/daemon run_backend.py";
        assert!(!matches_daemon_filter(&exe, cmdline, &linux_python_dir()));
    }

    #[test]
    fn filter_rejects_sibling_dir_with_shared_prefix_string() {
        // 易错点：字符串 starts_with 让 /foo/pythonX 误匹配 /foo/python。
        // 必须按路径分量（component）比较：/foo/pythonX 不是 /foo/python 的子目录。
        let app = PathBuf::from("/foo/python");
        let exe = PathBuf::from("/foo/pythonX/bin/python");
        let cmdline = "run_backend.py";
        assert!(
            !matches_daemon_filter(&exe, cmdline, &app),
            "路径前缀应是 component 级而非字符串级"
        );
    }

    #[test]
    fn filter_accepts_direct_child_python_dir() {
        // exe = <app>/python/python.exe（直接子目录） → 命中
        let app = PathBuf::from("/foo");
        let exe = PathBuf::from("/foo/python/python.exe");
        let cmdline = "run_backend.py";
        assert!(matches_daemon_filter(&exe, cmdline, &app));
    }

    #[test]
    fn filter_handles_empty_cmdline() {
        let exe = PathBuf::from(
            "/home/user/.local/share/com.posthub.desktop/python/cpython-3.11/bin/python3.11",
        );
        assert!(!matches_daemon_filter(&exe, "", &linux_python_dir()));
    }

    #[test]
    fn filter_handles_unicode_cmdline() {
        // 中文路径/参数：含 run_backend.py 即可
        let exe = PathBuf::from(
            "/home/user/.local/share/com.posthub.desktop/python/cpython-3.11/bin/python3.11",
        );
        let cmdline = "uv run --project /家目录/发布中枢 run_backend.py --title 早上好";
        assert!(matches_daemon_filter(&exe, cmdline, &linux_python_dir()));
    }

    #[test]
    fn filter_rejects_empty_exe_path() {
        // exe 解析失败（空路径）：不命中
        assert!(!matches_daemon_filter(Path::new(""), "run_backend.py", &linux_python_dir()));
    }

    #[test]
    fn sweep_empty_process_list_is_noop() {
        // 不调用 sysinfo：传空 iter 等价语义，直接断言空列表返回 0；
        // 这里用 sweep_stale_daemons 在一个空 app_data_dir 调用——应返回 0 且不 panic。
        let app_data = std::env::temp_dir().join("posthub-sweep-empty");
        let _ = std::fs::remove_dir_all(&app_data);
        std::fs::create_dir_all(&app_data).unwrap();
        let killed = sweep_stale_daemons(&app_data);
        assert_eq!(killed, 0);
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
