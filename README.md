# PostHub（发布中枢）

三平台短视频自动发布工具：一个视频，一键 / 定时发布到 抖音、小红书、视频号。

## 架构

- **形态**：Tauri 2 桌面应用（Windows 托盘 / macOS 菜单栏常驻）+ 常驻 Python 守护进程，本地 IPC 通信
- **前端**：Vue 3 + Vite + Element Plus + Pinia
- **发布引擎**：基于 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（patchright 驱动），**不 fork**，经 `uv` 作为依赖安装调用
- **账号模型**：每账号 = 一台本机 Chrome（独立 `user-data-dir`）+ 独立调试端口；发布脚本 `connect_over_cdp` 接管真实浏览器，登录态天然持久化
- **任务模型**：一个发布任务展开为 N 个平台子任务；同平台严格串行，跨平台并行（默认 2–3）

## 仓库结构

```
src-tauri/   Tauri 2 壳（Rust）：托盘 / 菜单栏常驻、一键退出、开机自启、拉起守护进程
web/         Vue 3 + Vite + Element Plus + Pinia 前端（守护进程健康检查页）
daemon/      Python 守护进程（uv 管理）：本地 HTTP IPC + conf 模块 + 任务执行引擎 seam
scripts/     工程辅助脚本（图标生成等）
```

## 开发

前置：Rust / Node 18+ / [uv](https://docs.astral.sh/uv/)。

```bash
# Python 守护进程（uv 管理）
cd daemon && uv sync && uv run pytest        # 守护进程全量测试
uv run python -m posthub                      # 启动守护进程（默认 127.0.0.1:8756）

# 前端
cd web && npm install
npm run dev                                    # Vite dev（端口 5173）
npm test                                       # 前端测试（Vitest）
npm run build                                  # 产物到 web/dist

# 桌面壳
cd src-tauri && cargo build                    # 编译调试版
cargo test                                     # Rust 单元测试
```

`tauri dev`（web 目录内 `npm run tauri dev`）可拉起前端 dev server + 桌面壳，壳启动时自动
经 `uv run --project daemon python -m posthub` 拉起守护进程，前端健康检查页即可看到连通状态。

## 许可证

MIT License，见 [LICENSE](LICENSE)。

> 本项目发布引擎参考 [social-auto-upload](https://github.com/dreammis/social-auto-upload)
> （MIT），以依赖方式接入、不 fork、不修改其源码。
