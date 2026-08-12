# ADR-0004: 桌面端打包与 daemon 运行时分发

- **状态**：已批准（desktop 双端落地决策）
- **日期**：2026-08-13
- **范围**：执行规范，含代码。mac + win 双端 Tauri 安装包的构建路径与 Python 守护进程的运行时交付方式。

## 背景

「做好 mac + win 双端桌面应用」需解决两个问题：

1. **daemon 运行时随安装包分发**。`spawn_daemon` 原实现靠本机 `uv` 命令 + 仓库相对路径 `daemon/` 拉起；安装后 `daemon/` 目录与 `uv` 均不存在，桌面应用不完整。
2. **Windows 安装包构建路径**。macOS 上无法原生构建 Windows 安装包（需要 NSIS/WiX + Windows 工具链），仓库无 CI。

## 决策

### 1. daemon 分发：源码 + uv 二进制作为 Tauri resources

- `daemon/` 源码（`scripts/prepare_resources.py` staging，排除 `.venv`/`__pycache__`/`cookies`/`logs`）+ 当前平台 `uv` 单二进制，作为 `bundle.resources` 打进安装包。
- `spawn_daemon` 解析顺序：env `POSTHUB_DAEMON_DIR` → 仓库 `daemon/`（dev）→ `resource_dir()` 内置资源；命令同理（env `POSTHUB_DAEMON_CMD` → 内置 uv → 系统 `uv`）。
- **venv 不建在资源目录**：安装目录（/Applications、Program Files）只读；首次启动把 venv 建在可写 `app_data_dir()`，通过 `UV_PROJECT_ENVIRONMENT` 指定，`uv run --project <resources>/daemon python -m posthub` 启动。
- 首次冷启动 1–3 分钟（建 venv + 拉 git/PyPI 依赖）为已知代价，之后复用。

### 2. 排除 PyInstaller 冻结

daemon 顶层 `import conf` 来自上游 git 包，依赖树含 patchright 原生绑定；冻结成单文件兼容风险高、收益低。不采用。

### 3. Windows 安装包走 GitHub Actions 矩阵

`.github/workflows/build.yml` 矩阵 `macos-latest` / `windows-latest`，tauri-action 出安装包；push `v*` tag 触发，产物发布 GitHub Release draft。CI 只对 daemon 做冒烟（起服务 + health 检查），不跑真实发布。

### 4. 先无签名

无证书前提下先出无签名安装包（macOS Gatekeeper / Windows SmartScreen 有提示），签名 / 公证留独立项。

## 后果（下游影响）

- 安装包自足：最终用户无需预装 Python/uv；`POSTHUB_DAEMON_DIR` / `POSTHUB_DAEMON_CMD` 保留为覆盖逃生口。
- `tauri.conf.json` 构建命令由 `npm --prefix ../web` 改为 `pnpm --prefix web`（前端已迁 pnpm；tauri CLI 执行 beforeBuildCommand 时 cwd 为项目根，`--prefix web` 解析到 `PostHub/web`）。
- Windows 真机 CDP 兼容（`--remote-allow-origins=*` 握手、user-data-dir singleton、Chrome 版本 vs patchright）为已知风险，装机时验证。
