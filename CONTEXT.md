# CONTEXT.md — PostHub（发布中枢）

> single-context 领域文档。术语与决策的唯一事实来源；改术语先改这里，再改代码。
> 决策细节见 `docs/adr/0001-task-and-sqlite-schema.md`、`docs/adr/0002-manifest-batch-format.md`、`docs/adr/0003-frontend-react-shadcn-migration.md`、`docs/adr/0004-desktop-packaging.md`、`docs/adr/0005-scheduler-rules-single-source.md`、`docs/adr/0006-official-backend-thin-wrapper.md`、`docs/adr/0007-daemon-process-lifecycle-cleanup.md`。

## 领域

PostHub 让短视频创作者「一个视频，一键或定时发布到抖音 / 小红书 / 微信视频号三个平台」，无人值守、静默执行。PostHub 是在 social-auto-upload **官方后端 + 官方前端功能**之上的**最薄封装**：发布引擎、登录态、账号存储、定时语义全部照官方实现，PostHub 只提供「对非程序员友好的桌面化界面」与「保证能运行」。

## 架构

- **形态**：Tauri 2 桌面应用（Windows/macOS 桌面窗口，**不常驻托盘**，点击关闭即退出）+ 官方 Python 后端（Flask，`sau_backend.py`）本地进程，前端通过 HTTP + SSE 调用。
- **前端**：React + Vite + shadcn/ui（Tailwind + Radix），自 Vue 3 + Element Plus 全量迁移（ADR-0003）。页面功能以官方 `sau_frontend` 为对照标准：发布（选视频/选账号/填信息/提交）、账号（扫码登录/校验/删除）、文件（上传/列表/删除）、定时、批量、cookie 导入导出。
- **发布引擎**：**官方后端的发布链路**（基于 social-auto-upload 的 `uploader/*`，patchright），**不 fork、不改官方源码**。官方 `sau_backend.py` 及其 `myUtils`（登录 / 发布 / 账号校验）作为上游 git 依赖引入（经 `uv`），桌面壳随应用启动官方后端进程。
- **不造轮子**：凡官方已覆盖的功能（发布、登录、账号、定时、批量、cookie、文件）一律复用官方，不自研等价实现。**只有官方没有的功能才自研**。

## 核心概念（glossary）

| 术语 | 定义 |
|---|---|
| **官方后端** | social-auto-upload 自带的 Flask 服务 `sau_backend.py`（含 `myUtils` / `uploader/*` / `conf.py` / 自带 `database.db`）。提供 `/upload`、`/login`(SSE) 、`/getValidAccounts`、`/postVideo`、`/postVideoBatch` 等接口；PostHub 发布的能力真源。 |
| **官方前端** | social-auto-upload 自带的 `sau_frontend`（Vue 3）。PostHub 不直接使用，仅作为功能对照标准；PostHub 用 React 技术栈重写其功能。 |
| **桌面壳** | PostHub 的 React 前端 + Tauri 2 打包。唯一自研层：把官方后端功能做成可双击运行的桌面 app，**不常驻托盘，点叉即关**。 |
| **账号 Account** | 官方后端 `user_info` 表 + `cookiesFile/*.json`（storage_state 格式）承载的登录态单元。每个账号 = 一个用户记录 + 对应 cookie 文件，无独立 Chrome 进程 / 无调试端口。 |
| **定时发布** | 官方后端 `/postVideo` 的 `enableTimer` 语义：`videos_per_day` / `daily_times` / `start_days`。 |
| **seam** | 前端 ↔ 官方后端的 **HTTP / SSE 接口契约**（`/upload`、`/login`、`/postVideo` 等）。一切自研前端功能必须落在该 seam 之上。 |
| **平台** | 抖音 `douyin` / 小红书 `xiaohongshu` / 视频号 `wechat`。官方后端用整型标识：1=小红书 2=视频号 3=抖音 4=快手。 |
| **桌面壳进程树** | 桌面壳 spawn 官方后端时的进程链：直接子进程 = `uv` trampoline（v0.1.4 起 `AppData\Roaming\com.posthub.desktop\venv\Scripts\python.exe`）；孙进程 = managed python（`AppData\Roaming\com.posthub.desktop\python\cpython-3.11...\python.exe`）；孙进程跑 `run_backend.py`。治理见 ADR-0007。 |
| **进程树清理** | 桌面壳在退出 / 启动两个时机的治理（ADR-0007）：退出用 `taskkill /F /T /PID <child.id()>` + `child.wait()`；启动前 `sweep_stale_daemons` 用 `sysinfo::System::new_all()` 枚举进程，过滤「`app_data_dir()/python` 路径前缀」+「cmdline 含 `run_backend.py`」双重条件后逐个 `taskkill /T` 杀树。 |
| **孤儿 daemon** | 桌面壳关窗口 / 崩溃 / 被强杀时，孙进程 managed python 因未被 spawn_daemon 的直接 `child.kill()` 覆盖而残留，**继续监听 5409**。每次重新打开 PostHub 都会刷一对新链路，**多次开关导致 N 对链路并存**，新链路因端口被占而抢不到连接——表现为扫码登录 SSE 一直 0 字节。 |
| **矩阵批量** | 「批量发布」区段的产品形态（issue #37/#38/#39）：每视频一条 BatchItem（独立标题 / 描述 / 标签 / 账号 / 定时模式），不再笛卡尔展开成「标题 × 账号」共享一份内容。提交时一行 BatchItem 展开为多条 PostVideoRequest（每账号一条），一次 POST `/postVideoBatch`。 |
| **整批共用 dailyTimes** | 矩阵批量下，顶部 chip 池「每日时刻（HH:MM）」是整批共享的定时时刻池；每条 BatchItem 进入 timer 模式时必须从该池挑 1 个 timeOfDay（不能在 item 内自由输入），避免时刻分散在多条 item 上、提交时由 `buildBatchItemsFromMatrix` 按整点取整映射回 0–23 整型数组下发。 |
| **无 CLI** | PostHub 不发布命令行工具（`posthub` CLI / `ph` 子命令等）；所有交互走桌面壳 GUI。官方 `sau_backend.py` 仍由桌面壳作为子进程拉起（不在用户 shell 暴露）。PostHub 用户面对的「官方后端」只通过桌面壳的 HTTP/SSE seam 触达。 |

## 平台约束注册表（已实测/调研）

| 平台 | 枚举值 | `min_lead_time` | 定时窗口 | 每日上限 | 封面 |
|---|---|---|---|---|---|
| 抖音 | `douyin` | 2h | 2h ~ 14 天 | — | 强制（自动选推荐封面） |
| 小红书 | `xiaohongshu` | **1h** | 2h ~ 7 天 | — | 缺封面自动取首帧 |
| 微信视频号 | `wechat` | 2h | 2h ~ 1 个月 | 本批次该账号累计定时任务数（UI 仅展示本批次，跨批次历史由官方兜底） | 缺封面自动取首帧 |

> 注：以上注册表来自历史调研，官方后端的实际定时约束以官方实现为准；自研前端不重复实现这些约束的校验，违规由官方返回错误。

## 状态与调度

- **无自研任务状态机 / 调度器 / 重试 / 限速 / 并发控制**（ADR-0006 已 supersede）。任务提交后即委托官方后端执行（`/postVideo` 立即返回，实际发布在官方线程内进行）。
- 官方后端一次可提交多账号（`accountList`）、多文件（`fileList`）、批量（`postVideoBatch`）；定时用 `enableTimer`。并发与顺序语义由官方实现决定。

## 命名与数据约定

- PostHub 侧不再维护 `task` / `platform_job` / `account` / `batch` SQLite 表（ADR-0001 的自研引擎已废弃）；登录态与文件元数据由官方 `database.db`（`user_info` / `file_records`）承担。
- 平台枚举命名（CONTEXT.md 层）：`douyin` / `xiaohongshu` / `wechat`。对接官方后端时映射到官方整型（1=小红书 2=视频号 3=抖音 4=快手）。
- 所有 Python 用 `uv` 管理，不用裸 pip / venv。
- 官方代码（`uploader/*`、`sau_backend.py`、`myUtils`、`sau_frontend`）不 fork、不改；PostHub 只在 seam（HTTP）与桌面壳侧包一层。

## 待验证项（真实账号实测后回填）

- 平台边界值（A 组遗留，未实测，保留为已知未确认值）：视频号单日上限（UI 侧以本批次累计 5 条为软提示阈值 `warn`/`warn-deep`，仅展示不拦截；跨批次历史由官方兜底校验）；抖音时长/视频号大小/小红书缺封面取首帧等官方实际约束。
- 官方后端线程模型在桌面壳内的稳定性：`sse_stream` 轮询式 SSE、`run_async_function` 每路事件循环、`MAX_CONTENT_LENGTH=160MB`、默认 `host=0.0.0.0:5409` 的暴露面是否需要改为仅本机。
- 官方 `database.db` 初始化时机与首次运行引导（官方要求手工建库/删建，封装时做成首次启动自动建库）。

## 历史备注（不再适用）

- 此前的「唯一注入面 = CDP 接管（patch `chromium.launch`→`connect_over_cdp`）」「账号 = 独立本机 Chrome + 独立调试端口」**已随 ADR-0006 废弃**。原因：视频号发布页在 CDP 连接存续期间不渲染发布编辑器，导致 `set_input_files` 超时；改为官方原生链路（自起浏览器 + storage_state 注入）即规避，且不再维护独立 Chrome/调试端口/多进程堆积的复杂度。