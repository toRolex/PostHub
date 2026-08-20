# PostHub 部署与运维

PostHub 是 Tauri 2 桌面应用（Windows / macOS，无托盘）+ 常驻 Python 守护进程（`daemon/`）。
安装包由 GitHub Actions 构建并发布到 Release，**不需要**在目标机预装 Python / uv / Chrome。

## 目标机器

| 角色 | SSH 别名 | 用户 | 说明 |
|------|---------|------|------|
| 生产机 | `prod-jump` | `zyt18` | 公司 Windows 机器，日常使用的主机（经跳板 `zyt` 连接） |
| 测试机 | `zyt` | `zyt` | 个人日常也在用的机器，兼作连生产机的跳板；PostHub 装包 / 升级 / 发布先在这台验证 |

> 以上 SSH 别名与 `~/.ssh/config` 来自 brandflow 项目的 `docs/deployment.md`，两台机器为
> PostHub 与 brandflow 共用。SSH 配置里的 `Host prod-jump`（`HostName 192.168.31.222`、
> `User zyt18`、`ProxyJump zyt@100.121.152.103`）即 PostHub 生产机。
>
> `zyt` 是个人日常也在用的测试机（勿当纯粹的空闲跳板），PostHub 装包 / 升级 / daemon 冷启动 /
> CDP 接管账号 Chrome 也在这台验证。数据目录 `C:\Users\ziyua\.posthub\`，应用数据
> `C:\Users\ziyua\AppData\Roaming\com.posthub.desktop\`。
>
> 当前可达性（2026-08-19 实测）：`ssh zyt` 与 `ssh prod-jump` 均通。跳板机走 Tailscale，
> 若 `prod-jump` 超时，先确认 `zyt`（100.121.152.103）Tailscale 在线。

## 安装

### 1. 获取安装包

走 GitHub Release 下载现成产物，不要手动构建：

```bash
gh release list                  # 看最新版本
gh release download <tag> -p "*x64-setup.exe"   # 下载 Windows 安装包
gh release download <tag> -p "*.dmg"            # 下载 macOS 安装包
```

Windows 安装包体积约 145MB（含 Chromium；见 ADR-0004 §修订 5）。

### 2. 安装 & 首次启动

- 双击 `PostHub_x64-setup.exe`。安装包未签名，Windows 会弹 SmartScreen，点「更多信息 → 仍要运行」。
- 首次启动后台 `daemon` 需联网拉依赖（`uv sync`，1–3 分钟冷启动），之后复用 venv。
  Windows 首次启动会复制打包的 Chromium 到 app_data（离线，不连海外 CDN）。
- 应用无托盘；关窗口即退出（同时结束后台 daemon 子进程）。

### 3. 升级

桌面应用没有自动更新通道。升级 = 下载新版安装包重新安装（覆盖安装，数据不丢）。

**发布新版本流程**（在开发机）：

```bash
# 1. bump 版本，两处必须一致：
#    a. src-tauri/tauri.conf.json 的 "version"
#    b. daemon/posthub/__init__.py 的 __version__   ← 前端左下角显示的是这个值
# 2. push v* tag → 触发 .github/workflows/build.yml（mac + win 矩阵构建）
git tag v0.1.3 && git push origin v0.1.3
# 3. CI 完成：把产物发布到 GitHub Release（draft）
gh release create v0.1.3 --title "PostHub v0.1.3" --generate-notes
```

> **版本显示注意**：界面右上角连通指示与版本来自官方后端；官方后端无 `/health` 路由，
> 连通判定用 `/getAccounts` 探活（无副作用，见「验证 daemon 状态」）。版本号以
> 安装包 / Release 为准。

## 运行时目录

两个目录各司其职，排查前先分清：

### 数据目录 `~/.posthub/`

| 路径 | 内容 |
|------|------|
| `~/.posthub/posthub.db` | SQLite：`account` / `task` / `platform_job` / `batch` / `log` 表 |
| `~/.posthub/profiles/` | 每账号独立 Chrome `user-data-dir`（登录态持久化在这） |
| `~/.posthub/cookies/{账号id}.json` | 上传前从账号 Chrome 导出的 storage_state 快照（上游校验用） |

生产机即 `C:\Users\zyt18\.posthub\`；验证机 zyt 即 `C:\Users\ziyua\.posthub\`。可用环境变量 `POSTHUB_DATA_DIR` 覆盖（一般不用）。

> 「账号 id」是 `account` 表主键（自增），不是平台名。例：`cookies/12.json` 是 id=12 的账号。
> 登录态本体在 `profiles/<platform>-<port>/`；`cookies/*.json` 只是快照（见上表）。

### 应用数据目录 `%APPDATA%\com.posthub.desktop`（Windows）/ `~/Library/Application Support/com.posthub.desktop`（macOS）

Tauri 的 `app_data_dir`，由桌面壳写入：

| 路径 | 内容 |
|------|------|
| `<app_data>/backend.log` | **daemon 子进程日志（stdout/stderr 全量重定向）**，daemon 失败原因看这 |
| `<app_data>/venv/` | daemon 的独立 venv（`UV_PROJECT_ENVIRONMENT`） |
| `<app_data>/python/` | 隔离的 managed Python（Windows，绕开 `%APPDATA%\uv\python` junction 问题） |
| `<app_data>/ms-playwright/` | 打包 Chromium 的运行时副本（`PLAYWRIGHT_BROWSERS_PATH`） |

## 验证 daemon 状态

桌面壳拉起 daemon 后监听 `http://127.0.0.1:5409`。可在目标机直接探活：

```cmd
curl http://127.0.0.1:5409/getAccounts
:: {"code":200,"msg":"ok","data":[...]}  账号列表（官方 JSON 契约）
curl http://127.0.0.1:5409/getFiles
:: {"code":200,"msg":"ok","data":[...]}  素材记录
```

连通判定：官方后端无 `/health` 路由，桌面壳与前端都用 `/getAccounts` 探活
（2xx = 就绪；无副作用）。

常规问题：`5409` 端口被占、daemon 起不来 → 前端显示「守护进程未连接」。

## 常见问题排查

### 1. 视频号发布报「cookie文件不存在，请先完成视频号登录」

**报错来源**：上游 `social-auto-upload` 的 `uploader/tencent_uploader/main.py:505`
`validate_base_args` 检查 `account_file` 是否物理存在，不存在就抛这个错。

**机制**：PostHub 用 CDP 接管账号 Chrome（登录态在 Chrome profile 里），v0.1.2 起在
上传时把 `context.storage_state` **导出**到 `~/.posthub/cookies/{账号id}.json`，之后
上游校验才能通过。报错意味着**导出没发生或导出的文件没写入**。

排查顺序：

```cmd
:: 1. 确认 cookies 文件是否生成
dir C:\Users\zyt18\.posthub\cookies\
:: 若 12.json 不存在 → 是版本问题（v0.1.2 之前没有导出逻辑）或导出失败

:: 2. 确认账号 Chrome 是否在运行（导出依赖 CDP 连接）
::    账号列表里平台/端口：查 posthub.db 或 /getAccounts 接口
netstat -ano | findstr :<cdp_port>

:: 3. 看 daemon 日志里上传时的报错
notepad %APPDATA%\com.posthub.desktop\backend.log
```

- **旧版本（< v0.1.2）**：代码根本没有导出逻辑 → 升级到 v0.1.2+（这是最可能的原因）。
- **v0.1.2 装了仍报**：说明**导出没发生**。导入逻辑是 `UpstreamUploadExecutor.upload`
  在 `cdp_attach` 里 `context.storage_state(path=account_file)`；若此时账号 Chrome 没起、
  CDP 连不上，这个 await 会抛异常并冒泡成发布失败（终态 failed，日志可见），**不报**本文案。
  若文件连失败日志都没有就报「cookie文件不存在」→ 是安装包版本问题，与「现场冒出旧的 .posthub
  数据库/账号」叠加时，先升级再重试发布。
- 账号划为 `needs_relogin` 时：到账号管理页对该账号发起重新扫码，恢复后再发布。

### 2. 守护进程未连接

- 看 `backend.log`：`uv run` 失败原因（首次冷启动联网失败、端口占用、Python 安装失败）。
- Windows 首次启动日志若能起来：常见 `os error 448`（junction 问题）已在 v0.1.1+ 修复，
  输出隔离到 app_data；仍出现则看完整 log。
- 兜底逃生口：设 `POSTHUB_DAEMON_DIR` / `POSTHUB_DAEMON_CMD` 指向自备 daemon 目录 / uv。

### 3. 发布失败排查怎么开始

先分类再深入，别一上来改代码：

1. 打开 PostHub → 任务管理页看该 job 终态（failed / manual / needs_relogin）。
2. `curl http://127.0.0.1:5409/getFiles` 或查 `~/.posthub/posthub.db` 的 `log` 表，看错误消息。
3. 错误 → 终态映射见 `CONTEXT.md`：`network` → 重试；`auth` → `needs_relogin` 重登；
   `risk_control` / `unknown` → `manual` 人工介入。

### 4. 硬要低层排查

登录态、账号、任务都落在 `~/.posthub/posthub.db`，可在目标机只读查询：

```cmd
:: 需要 sqlite3（目标机未必有）；也可在本机把 db 拉下来看
:: 表：account / task / platform_job / batch / log
sqlite3 C:\Users\zyt18\.posthub\posthub.db "select id,platform,cdp_port,status from account;"
```

### 5. 扫码登录异常自助排错（升级前 / 升级后均可用）

对应 issue #29 User Story #12：v0.1.5 起桌面壳已在退出 + 启动两个时机清
理进程树（taskkill /F /T 杀整条），5409 同名端口通常只剩一个 LISTEN。若升
级后扫码登录仍异常，先**自助**确认端口状态（不直接改代码）：

```cmd
:: 1. 看 5409 上有几个 LISTEN。正常 = 1 个；多个 = 上轮关闭有孙进程未收掉。
netstat -ano | findstr :5409 | findstr LISTENING
```

- 若只有 1 个 LISTEN → 与进程残留无关；改查 `backend.log` / `cookies/`（见 §1、§2）。
- 若有多个 LISTEN → 应急清理（一次性的 taskkill，不替代桌面壳自动清扫）：

```cmd
:: 2. 把 5409 上所有 LISTEN 进程的 pid 逐个 taskkill /F /PID。
::    注意：不带 /T（不像桌面壳的清扫），只杀 LISTEN 那一层；孙进程会在父死后被 uv 回收。
for /f "tokens=5" %a in ('netstat -ano ^| findstr :5409 ^| findstr LISTENING') do taskkill /F /PID %a
```

```cmd
:: 3. 确认只剩 0 个 LISTEN（PostHub 关掉的状态下），再重新打开 PostHub。
netstat -ano | findstr :5409 | findstr LISTENING
```

重开后扫码登录应能正常出码；若仍异常，按 §1 排查 cookie 文件或 §2 排查
`backend.log`，不再走本节。

## 远程连接（Windows 机器）

目标机是 Windows，SSH 命令要用 `cmd /c` 包一层，且先切 UTF-8 避免中文乱码：

```bash
# 验证机 zyt / 生产机（经跳板）— 示例
ssh zyt cmd /c "chcp 65001 >nul && dir C:\Users\ziyua\.posthub\cookies"
ssh prod-jump cmd /c "chcp 65001 >nul && dir C:\Users\zyt18\.posthub\cookies"

# 下拉 db / 日志到本机分析（路径用 /）
scp zyt:"C:/Users/ziyua/.posthub/posthub.db" /tmp/
scp zyt:"C:/Users/ziyua/AppData/Roaming/com.posthub.desktop/backend.log" /tmp/
iconv -f GBK -t UTF-8 /tmp/backend.log > /tmp/backend.utf8.log   # 中文日志转码
```

> 若既有中文路径/文件名又要管道拼接，参考 brandflow `docs/deployment.md` 的
> 「SSH 通道乱码应对」：本机写脚本 → SCP 上去 → `-File` 执行 → 结果落 ASCII 文件 → SCP 回。

## 运维纪律

- 动手前先在目标机只读排查（`curl /getAccounts` 探活、看 `backend.log`、查 cookies 目录）；
  不直接在目标机改 daemon 源码——安装包里的代码是构建期 staging 的，现场改无效且不可复现。
- 真 bug 一律走开发机：改代码 → 写测试 → bump 版本 → tag → CI 构建 → 发 Release → 目标机升级。
- Windows 安装包未签名：SmartScreen 提示属正常，不是安装包损坏（见「安装 & 首次启动」）。