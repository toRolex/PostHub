# PostHub（发布中枢）

三平台短视频自动发布工具：一个视频，一键 / 定时发布到 抖音、小红书、视频号。

## 架构

- **形态**：Tauri 2 桌面应用（Windows 托盘 / macOS 菜单栏常驻）+ 常驻 Python 守护进程，本地 IPC 通信
- **前端**：React 19 + Vite + Tailwind CSS v4 + shadcn/ui（Zustand 状态管理）
- **发布引擎**：基于 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（patchright 驱动），**不 fork**，经 `uv` 作为依赖安装调用
- **账号模型**：每账号 = 一台本机 Chrome（独立 `user-data-dir`）+ 独立调试端口；发布脚本 `connect_over_cdp` 接管真实浏览器，登录态天然持久化
- **任务模型**：一个发布任务展开为 N 个平台子任务；同平台严格串行，跨平台并行（默认 2–3）

## 仓库结构

```
src-tauri/   Tauri 2 壳（Rust）：托盘 / 菜单栏常驻、一键退出、开机自启、拉起守护进程
web/         React 19 前端（Zustand + Tailwind v4 + shadcn/ui），pnpm 管理
daemon/      Python 守护进程（uv 管理）：本地 HTTP IPC + conf 模块 + 任务执行引擎 seam
scripts/     工程辅助脚本（图标生成、打包资源准备等）
```

## 开发

前置：Rust / Node 18+ / pnpm / [uv](https://docs.astral.sh/uv/)。

```bash
# Python 守护进程（uv 管理）
cd daemon && uv sync && uv run pytest        # 守护进程全量测试
uv run python -m posthub                      # 启动守护进程（默认 127.0.0.1:8756）

# 前端（pnpm）
cd web && pnpm install
pnpm run dev                                    # Vite dev（端口 5173）
pnpm test                                       # 前端测试（Vitest）
pnpm run build                                  # 产物到 web/dist

# 桌面壳
cd src-tauri && cargo build                    # 编译调试版
cargo test                                     # Rust 单元测试
```

桌面壳 dev（项目根执行）：`web/node_modules/.bin/tauri dev` 拉起前端 dev server + 桌面壳；
壳启动时自动经 `uv run --project daemon python -m posthub` 拉起守护进程，前端即可看到连通状态。

## 打包 / 发布

前置：Rust / Node 18+ / pnpm / uv。

```bash
# 1. 准备打包资源：staging daemon 源码（排除 .venv 等）+ 下载当前平台 uv 二进制
uv run --project daemon python scripts/prepare_resources.py

# 2. 构建安装包（项目根执行）
web/node_modules/.bin/tauri build
```

产物：macOS `src-tauri/target/release/bundle/dmg/*.dmg`；Windows `*.exe`（NSIS，需在 Windows
或 CI 构建）。Windows 安装包经 GitHub Actions 矩阵构建（`.github/workflows/build.yml`），
push `v*` tag 触发，产物发布到 GitHub Release draft。

**daemon 运行时随包分发**：安装包内置 `daemon/` 源码 + 平台 `uv` 二进制；首次启动在应用数据目录建
venv（`UV_PROJECT_ENVIRONMENT`），需联网拉依赖（1–3 分钟冷启动），之后复用。环境变量
`POSTHUB_DAEMON_DIR` / `POSTHUB_DAEMON_CMD` 可覆盖运行时。

当前安装包未签名：macOS 首次打开需右键「打开」，Windows 有 SmartScreen 提示。

## 许可证

MIT License，见 [LICENSE](LICENSE)。

> 本项目发布引擎参考 [social-auto-upload](https://github.com/dreammis/social-auto-upload)
> （MIT），以依赖方式接入、不 fork、不修改其源码。
