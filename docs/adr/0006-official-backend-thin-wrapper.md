# ADR-0006: 重构为「官方后端 + 自研桌面壳」的最薄封装

- **状态**：已批准（grill-with-docs 收口；用户拍板方案 A）
- **日期**：2026-08-18
- **范围**：执行规范，含代码（本次仅决策与文档，代码实现随后续轮落地）。将 PostHub 自研的执行引擎整体回退，改为对 social-auto-upload **官方后端（`sau_backend`）+ 官方前端（`sau_frontend`）功能**的最薄封装：自研前端仅负责交互，发布执行一律委托官方后端。

## 背景

PostHub 最初按 ADR-0001 设计为「任务 + SQLite + 自研状态机/调度器 + CDP 接管账号 Chrome 发布」（`daemon/posthub/`）。真实发布验证（issue #11 之后）暴露核心缺陷：**视频号发布页在存在 CDP 连接时不渲染发布编辑器，导致 `set_input_files` 超时**（handoff/探针证据）。排查同时反证上游 social-auto-upload 的原生路径是**自起浏览器 + `new_context(storage_state=账号cookie)`**，且上游自带官方 Web GUI（`sau_backend.py` Flask + `sau_frontend` Vue3），能覆盖登录/选账号/发布/定时/批量/cookie 全流程。

用户需求明确收紧为：**「在 social-auto-upload 基础上做最小封装并保证能运行；不造轮子、造了就用作者的；只有没有的功能才加上」**，并指定**前端用自研技术栈（React 技术栈 + Tauri）重写官方 GUI 的功能**，**不常驻托盘（点叉即关）**。

## 决策

1. **执行基座 = 官方后端**：发布、登录（扫码 cookie 生成）、账号校验、cookie 导入导出、定时发布、批量发布，全部委托官方 `sau_backend.py` 及其依赖（`myUtils` / `uploader/*`）完成。**自研 daemon 执行引擎（`daemon/posthub/` 下 `scheduler.py` / `rules.py` / `state.py` / `tasks.py` / `engine.py` / `uploader.py` / `cdp_attach.py` / `accounts.py` / `constraints.py` / `interventions.py` / `logs.py` / `management.py` / `manifest.py`）整体废弃删除**——它们是对上游能力与账号模型的重复实现，不再保留。
2. **界面层 = 自研 Tauri + React**：以官方 `sau_frontend` 的功能为**对照标准**，用现有 React 技术栈（Vue → React 迁移早已落地，ADR-0003 前提不变）重构为 Tauri 桌面 app；功能范围与官方 GUI 对齐，不新增不必要功能。**不常驻托盘**：点击窗口关闭即退出应用（与托盘常驻相反的交互语义，用户明确要求）。
3. **官方前端（`sau_frontend`）/ 官方后端（`sau_backend`）保留不动**：均作为上游仓库（git 依赖 / venv 内）的组成部分，PostHub 不 fork、不修改；桌面壳打包时引入或随依赖安装，运行时由 PostHub 启动官方后端进程。
4. **登录态语义回归官方**：账号登录态 = 官方 `cookiesFile/*.json`（storage_state 格式），经官方 `/login` 扫码生成、`/getValidAccounts` 校验、`/postVideo` 消费。**CDP 接管账号 Chrome 的模型废除**；账号之间不再需要独立调试端口 / 独立 user-data-dir。
5. **前端 ↔ 后端的 seam = 官方 HTTP + SSE 接口**：自研前端对接官方后端的 HTTP 接口（`/upload`、`/uploadCookie`、`/login`(SSE)、`/getValidAccounts`、`/postVideo`、`/postVideoBatch`、`/deleteFile`、`/deleteAccount`、`/getFiles`、`/getAccounts` 等），不新增自研后端。

## 与旧 ADR 的 Supersede 关系

- **Supersede ADR-0001 §上传执行 / 账号模型**：CDP 接管、`cdp_attach`、`UpstreamUploadExecutor`、`platform_job`/`account` 表驱动发布全部取消。ADR-0001 中与官方能力重复的模型（任务/平台子任务/账号/批次 SQLite 表）不再作为执行真源；官方后端自带 `database.db`（`file_records` / `user_info`）承担登录态与文件元数据存储。
- **Supersede ADR-0001 §状态机 / 调度 / 重试 / 限速 / 并发**：任务级调度器与重试策略取消，改由官方后端 `enableTimer`（`videos_per_day` / `daily_times` / `start_days`）承担定时语义。
- **保持 ADR-0003（React + shadcn 前端基础）不变**，但目标从「面向自研 daemon 的 SPA」调整为「官方功能 + 桌面 Tauri 壳的 SPA」。
- **保持 ADR-0004（Tauri 桌面/打包）前提不变**，但内嵌的 daemon 由官方后端替代自研 daemon。
- **保持 ADR-0005 无效**：其对象（自研调度/迁移规则单一真源）随自研引擎一并废弃，规则模块不再是真源。
- **保持 ADR-0002 无效**：manifest 批量导入格式是自研引擎的产物，随引擎废弃；官方后端以 `postVideoBatch` 承担批量发布。

## 后果（下游影响）

- **代码删除面**：`daemon/posthub/` 自研引擎整体删除；`src-tauri` 中 spawn 自研 daemon/健康检查/IPC 对应逻辑删除，改为 spawn 官方后端。
- **依赖变化**：保留官方仓库依赖（patchright、Flask、CORS 等）；移除自研 daemon 专用依赖（如 `sqlite` 自研表迁移代码、CDP seam 相关）。
- **前端变化**：现有 Tauri + React 工程重写对齐官方功能页（发布、账号、文件、定时、批量、cookie 导入导出），会话/状态管理对接官方 HTTP+SSE。
- **测试变化**：删除自研引擎单测；新增对「官方后端接口契约」的适配层测试与打包可运行性冒烟测试。
- **领域文档**：CONTEXT.md 术语同步调整（见随附 ADR 配套的 CONTEXT 更新）：「唯一注入面 / 唯一 seam / CDP 接管 / 账号 Account（独立调试端口）”等旧表述退场。
- **行为不变保证**：发布走官方动机的原生链路（自起浏览器 + storage_state），视频号不再受 CDP 抑制影响。

## 待确认 / 未决项

- 官方后端的线程模型与并发安全（`sse_stream` 轮询占 CPU、`run_async_function` 每路事件循环）在桌面壳内的稳定性待实测。
- `database.db` 初始化时机与首次运行引导（官方要求手工建库/删建，需封装为首次启动自动建库）。
- 官方 Flask 默认 `host=0.0.0.0:5409` 的暴露面是否改为仅本机（`127.0.0.1`）——安全项待定。