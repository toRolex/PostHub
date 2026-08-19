# ADR-0007: 桌面壳官方后端进程树生命周期清理

- **状态**：已批准（grill-with-docs 收口；用户拍板）
- **日期**：2026-08-19
- **范围**：Tauri 桌面壳 `src-tauri/src/lib.rs` 中官方后端（`sau_backend.py` 进程）的 spawn / 退出 / 启动前清扫；新增 `sysinfo` 与 `tauri-plugin-single-instance` 两个 Cargo 依赖。

## 背景

桌面壳在 `setup` 里通过 `Command::new(uv).args(["run", "--project", <daemon>, "run_backend.py"])` 拉起官方后端子进程链：uv trampoline（直接子进程）→ managed python（孙进程，运行 `run_backend.py`）。`RunEvent::Exit` 阶段原代码只 `child.kill()` 直接子进程，**孙进程成孤儿继续监听 5409**。

实测后果（2026-08-19，测试机 zyt、生产机 prod-jump）：

- 测试机：4 条 daemon 链路并存，3 个进程同时 `LISTEN 5409`，连接分配倾向最先 bind 的 socket，旧 daemon 占着端口 → 扫码登录请求落旧进程、二维码 SSE 一直 0 字节（spinner 一直转）。
- 生产机：6 条链路跨 8/17、8/18、8/19 三天累积，5409 上 2 个 LISTEN。
- 旧 daemon 链路占位会**永远持续**：每次开 PostHub、退出不当（Tauri 崩溃、断电、被强杀、应用关窗口），都漏掉孙进程。

直接调 `douyin_cookie_gen` 函数是好的，SSE 在干净请求下能出 2943 字节二维码——证实 v0.1.4 的发布链路本身正常，根因在桌面壳的进程生命周期治理。

## 决策

1. **退出清理改为 `taskkill /F /T /PID <child.id()>`**（Windows 平台）：
   - `RunEvent::Exit` 块取 `child.id()` 后 `Command::new("taskkill").args(["/F","/T","/PID",&pid.to_string()]).output()`（`CREATE_NO_WINDOW` 抑制控制台）。
   - 杀完调 `child.wait()` 回收，避免 zombie。
   - 沿用 `RunEvent::Exit` 显式清理时机，不改用 `Drop for DaemonGuard`（panic-unsafe 时机不可控）。
2. **新增 `sweep_stale_daemons(app_data_dir)` 函数**，在 `setup` 里 `spawn_daemon` 之前调一次：
   - 使用 `sysinfo::System::new_all()` + `refresh_all()` 枚举进程（**Rust 内部完成**，不走 PowerShell / wmic，避免 100ms+ spawn 开销与编码坑）。
   - 过滤条件（**双条件精确匹配，避免误伤**）：
     - `exe_path()` 路径前缀等于 `app_data_dir().join("python")`，路径字符串 lowercase 比较（Windows 不区分大小写）。
     - `cmd_line()` 含子串 `run_backend.py`。
   - 命中后用 `taskkill /F /T /PID` 杀整条进程树（含孙进程的孙进程如 chromium.exe、playwright 子进程）。
3. **引入 `tauri-plugin-single-instance`**：第二次启动 PostHub 时把请求转发到第一个实例并激活窗口，不再 spawn 新的 daemon。**与启动清扫互补**：插件防「双开双起」，清扫防「崩溃后 daemon 残留」。
4. **路径匹配用运行期解析的 `app_data_dir()`，不硬编码字符串**。

## 与旧 ADR 的关系

- **承接 ADR-0006 §待确认 / 未决项**：「官方后端的线程模型与并发安全」中的进程生命周期稳定性。ADR-0006 只标记为「待实测」，本 ADR 给出治理规范。
- **承接 ADR-0004 §桌面打包**：安装包/升级场景的孤儿进程治理。
- **不修改 ADR-0006 的执行基座选择**：官方后端仍是执行真源；本 ADR 仅治理其进程生命周期，不改变「最薄封装」立场。

## 后果（下游影响）

- **代码改动**：
  - `src-tauri/src/lib.rs`：退出块加 `taskkill /F /T`；新增 `sweep_stale_daemons`；`setup` 里在 `spawn_daemon` 前调用；引入 `tauri-plugin-single-instance` 的 `.plugin(tauri_plugin_single_instance::init(...))` 注册。
  - `Cargo.toml`：加 `sysinfo` 与 `tauri-plugin-single-instance`。
- **测试**：
  - 纯函数单测：`sweep_stale_daemons` 的过滤逻辑（路径前缀 + cmdline 子串）用 fixture 测。
  - Windows 集成测试：`taskkill /T` 树清理——spawn 一个真 python 子进程模拟孙进程，杀父后断言孙进程已退出。））跨平台 CI 跑 windows runner。
- **可观察性**：`backend.log` / `daemon.log` / `taskkill` 调用产出的 stderr 仍在原重定向文件中，无需额外日志路径。
- **运维**：`docs/deployment.md` 补一条「升级前若扫码登录异常，先 `netstat -ano | findstr :5409` 确认只有一个 LISTEN」——清扫治标，但用户自助排错仍有用。

## 备选方案（已弃）

- **Windows Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**：系统级优雅，但需引 `windows-sys` 或 `win32job` 依赖，且只解决「本次崩溃」，解决不了历史残留（仍需启动清扫）。被弃：taskkill 务实够用，依赖面更小。
- **`wmic process` 枚举**（Win11 已默认移除）+ PowerShell `Get-CimInstance`：每次 spawn 有 100ms+ 开销；编码坑（GBK/UTF-8）。被弃：sysinfo 跨平台、Rust 内部、`。

` `、` 不依赖。
- **`Drop for DaemonGuard` 自动清理**：panic-unsafe，时机不可控，且不解决历史残留。被弃：显式 `RunEvent::Exit` 路径更可预测。
- **只修退出、不做启动清扫**：孙进程成孤儿发生在之前的版本上，升级上来的机器已有存量残留，单纯修退出不能立即解决存量症状。被弃：两个机制互补，不替代。

## 验证计划

1. **进程树形态实测**：在测试机 spawn 一次 `uv run --project <daemon_dir> run_backend.py`，用 sysinfo `parent()` 链确认 uv→python 是否真两进程、`/T` 是否覆盖孙进程。
2. **cargo test --lib**：过滤逻辑纯函数单测。
3. **Windows CI runner**：spawn 子进程 → taskkill /T → 断言孙进程已退出。
4. **生产机清理动作**：kill 全部 6 对链路（生产机当前 posthub.exe 不在运行，全是孤儿）→ `netstat -ano | findstr :5409` 确认无监听 → 重启 PostHub 一次验证 5409 仅一个监听、二维码出现。