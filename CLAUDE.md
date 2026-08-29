# PostHub

PostHub（中文「发布中枢」）—— 三平台短视频自动发布工具：一个视频，一键 / 定时发布到 抖音、小红书、视频号。

## 项目概述

- **形态**：Tauri 2 桌面应用 + Python 官方后端与 PostHub-owned 本机扩展，Tauri 通过本地 HTTP/进程 seam 调用
- **前端**：React + Vite + shadcn/ui（Tailwind + Radix）
- **发布引擎**：基于 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（patchright 驱动），**不 fork**，通过 `uv` 作为依赖安装调用
- **账号模型**：官方 `user_info` + `cookiesFile/*.json` 登录态，不使用独立 CDP Chrome 账号模型
- **任务模型**：批量由 `/postRuns` 立即受理，run worker 逐 item 委托官方 `/postVideo`；item/run 状态是唯一事实来源
- **许可证**：MIT；README 声明参考 social-auto-upload

## 工程约束

- 所有 Python 操作一律用 `uv` 管理，不使用裸 pip / venv
- 发布内核不直接修改上游源码；需要自定义行为时在 PostHub 侧包一层
- 平台 UI 自动化脆弱，改动前先查对应 `uploader/*` 的当前结构

## 关键术语

- **账号（Account）**：绑定单平台、单本机 Chrome 调试端口
- **任务（Task）**：一次发布动作，含 N 个平台子任务（Job）
- **批次（Batch）**：文件夹 + `manifest.json` 的批量导入单元

## Agent skills

### Issue tracker

GitHub Issues（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五角色标签（`needs-triage` 等）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。
