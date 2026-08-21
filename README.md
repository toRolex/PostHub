<div align="center">

# PostHub（发布中枢）

**一个视频，一键 / 定时发布到 抖音、小红书、视频号**

[![Release](https://img.shields.io/github/v/release/toRolex/PostHub?style=flat-square&color=blue)](https://github.com/toRolex/PostHub/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/toRolex/PostHub/build.yml?style=flat-square&label=build)](https://github.com/toRolex/PostHub/actions)
[![License](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)

[下载](#下载) · [特性](#特性) · [架构](#架构) · [快速上手](#快速上手) · [开发](#开发) · [打包](#打包--发布)

</div>

## 这是什么

PostHub 是一个桌面端的多平台短视频发布工具，目标是把「一个视频发到抖音 / 小红书 / 视频号」这件重复、机械、易触发风控的事，从人工逐平台操作变成 **一键 / 定时批量执行**。

- **本地 Chrome 登录态** —— 通过 `connect_over_cdp` 接管每账号独立的真实浏览器，登录态天然持久化
- **跨平台并行** —— 一个发布任务展开成 N 个平台子任务，跨平台并行、同平台严格串行
- **人工介入兜底** —— 验证码、需重登、错过排期等异常主动浮现，不藏在层级深处
- **AI 内容声明透传** —— 按平台分键（抖音 `declaration` / 视频号 `original_statement` / 小红书 `source`）写入，不靠 OCR 兜底（issue #43 / ADR-0008）

## 下载

最新稳定版：**v0.1.7**（[Release 页](https://github.com/toRolex/PostHub/releases/tag/v0.1.7)）

| 平台 | 安装包 | 大小 |
|---|---|---|
| macOS (Apple Silicon) | `PostHub_0.1.7_aarch64.dmg` | 19.7 MB |
| Windows (NSIS) | `PostHub_0.1.7_x64-setup.exe` | 246 MB |
| Windows (MSI) | `PostHub_0.1.7_x64_en-US.msi` | 343 MB |

> [!NOTE]
> 当前安装包未签名：macOS 首次打开需右键「打开」绕过 Gatekeeper；Windows 有 SmartScreen 提示，点「仍要运行」即可。

> [!WARNING]
> macOS 仅提供 aarch64（Apple Silicon）构建；Intel Mac 用户需自行从源码构建。

## 特性

### 账号管理

- 每账号 = 一台本机 Chrome（独立 `user-data-dir`）+ 独立调试端口
- 「打开」拉起 Chrome 扫码登录，发布脚本接管真实浏览器，**登录态天然持久化**
- 账号级默认声明（按平台分键），新建任务自动继承

### 素材与发布

- 官方素材库：上传视频 / 图片，发布时直接选取
- 文件夹批量导入：`manifest.json` 驱动多任务批量发布
- 矩阵批量（`BatchItem`）：每个视频独立标题 / 标签 / 账号组合，跨平台并发

### 任务调度与监控

- 任务管理页：发布进度、平台结果、人工介入状态一目了然
- 异常兜底：Tauri 弹窗 + 应用内通知 + 本地日志
- 调度器：定时任务、单日累计、视频号软提示等平台专属约束

### 内置守护进程

- Python 守护进程常驻：本地 HTTP IPC（默认 `127.0.0.1:5409`）
- 首次启动按需建 venv（`UV_PROJECT_ENVIRONMENT`），冷启动 1–3 分钟后复用
- 引擎层基于 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（MIT），**不 fork 不改源码**

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri 2 桌面壳 (Rust)                                       │
│  ├─ Windows 托盘 / macOS 菜单栏常驻                           │
│  ├─ 拉起守护进程 + 健康检查                                    │
│  └─ 桌面通知 / 人工介入弹窗                                     │
├─────────────────────────────────────────────────────────────┤
│  WebView (React 19 + Vite + Tailwind v4 + shadcn/ui)       │
│  ├─ 状态管理：Zustand                                        │
│  └─ 路由：账号 / 任务 / 文件 / 批量发布 / 监控                │
├─────────────────────────────────────────────────────────────┤
│  Python 守护进程 (uv 管理)                                    │
│  ├─ 本地 HTTP IPC（Flask + conf）                           │
│  ├─ 任务执行引擎 + 调度器                                     │
│  ├─ SQLAlchemy 状态机（SQLite）                              │
│  └─ uploader wrapper seam（PostHub 侧补 DOM / 声明透传）       │
├─────────────────────────────────────────────────────────────┤
│  发布引擎：social-auto-upload（patchright 驱动）                │
│  ├─ 每账号独立 Chrome (--user-data-dir + 调试端口)            │
│  └─ connect_over_cdp 接管真实浏览器                          │
└─────────────────────────────────────────────────────────────┘
```

### 仓库结构

```
src-tauri/   Tauri 2 壳（Rust）：托盘 / 菜单栏常驻、一键退出、开机自启
web/         React 19 前端（Zustand + Tailwind v4 + shadcn/ui），pnpm 管理
daemon/      Python 守护进程（uv 管理）：本地 HTTP IPC + 执行引擎 seam
scripts/     工程辅助脚本（图标生成、打包资源准备等）
docs/adr/    架构决策记录（ADR-0004 ~ ADR-0008）
docs/specs/  平台约束与功能规格
docs/handoffs/  Issue 实现交付快照
```

## 快速上手

> [!IMPORTANT]
> 守护进程首次启动会在应用数据目录建 venv（联网拉依赖）；如果你的网络受限，可提前在仓库内 `cd daemon && uv sync` 预热。

1. 从上方「下载」获取安装包，安装到你常用的桌面平台
2. 启动 PostHub，系统托盘 / 菜单栏出现图标
3. 「账号管理」→ 「打开」拉起 Chrome，扫码登录抖音 / 小红书 / 视频号
4. 「文件」上传你的视频 / 图片素材
5. 「发布」填标题 / 标签 / 平台，一键发布；或建定时任务

详细发布约束（封面、声明、字数）见 [`docs/specs/`](docs/specs/)。

## 开发

前置：Rust / Node 18+ / pnpm / [uv](https://docs.astral.sh/uv/)。

```bash
# Python 守护进程
cd daemon && uv sync && uv run pytest          # 守护进程全量测试
uv run python -m posthub                        # 启动守护进程（默认 127.0.0.1:5409）

# 前端
cd web && pnpm install
pnpm run dev                                     # Vite dev（端口 5173）
pnpm test                                        # Vitest
pnpm exec tsc --noEmit                           # TypeScript 检查

# 桌面壳
cd src-tauri && cargo build                     # 编译调试版
cargo test                                       # Rust 单元测试
```

桌面壳 dev（项目根执行）：`web/node_modules/.bin/tauri dev` 拉起前端 dev server + 桌面壳；壳启动时自动经 `uv run --project daemon python -m posthub` 拉起守护进程，前端即可看到连通状态。

### 关键设计约束

- **所有 Python 操作必须用 `uv`** —— 不使用裸 pip / venv，所有 `pyproject.toml` / `uv.lock` 是依赖规范
- **发布引擎不 fork** —— 需要自定义行为时在 PostHub 侧包一层（`daemon/posthub/declarations.py` / `uploader_wrapper.py`）
- **平台 UI 自动化脆弱** —— 改动前查 `social-auto-upload/uploader/*` 当前结构，避免依赖私有 DOM 路径

## 打包 / 发布

```bash
# 1. 准备打包资源：staging daemon 源码（排除 .venv 等）+ 下载当前平台 uv 二进制
uv run --project daemon python scripts/prepare_resources.py

# 2. 构建安装包（项目根执行）
web/node_modules/.bin/tauri build
```

产物：macOS `src-tauri/target/release/bundle/dmg/*.dmg`；Windows `*.exe` / `*.msi`（NSIS + MSI）。

CI 流程：push `v*` tag 触发 `.github/workflows/build.yml`，mac/win 双端构建 + 自动 attach 到 GitHub Release。详细发布流程见 [`docs/deployment.md`](docs/deployment.md)。

## 架构决策（ADR）

关键决策记录在 `docs/adr/`：

- ADR-0004：Windows 桌面打包与官方后端依赖治理
- ADR-0005：调度规则单一来源（任务状态机的语义边界）
- ADR-0006：官方后端薄封装（PostHub 仅包一层，不 fork 上游）
- ADR-0007：守护进程生命周期与退出清理
- ADR-0008：平台内容声明按平台分键透传（issue #43）

## 相关项目

- [social-auto-upload](https://github.com/dreammis/social-auto-upload) —— 发布引擎（MIT），被 PostHub 以依赖方式接入

## 许可证

MIT License，见 [LICENSE](LICENSE)。
