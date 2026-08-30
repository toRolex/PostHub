# CONTEXT.md — PostHub（发布中枢）

> single-context 领域文档。术语与决策的唯一事实来源；改术语先改这里，再改代码。
> 决策细节见 `docs/adr/0001-task-and-sqlite-schema.md`、`docs/adr/0002-manifest-batch-format.md`、`docs/adr/0003-frontend-react-shadcn-migration.md`、`docs/adr/0004-desktop-packaging.md`、`docs/adr/0005-scheduler-rules-single-source.md`、`docs/adr/0006-official-backend-thin-wrapper.md`、`docs/adr/0007-daemon-process-lifecycle-cleanup.md`、`docs/adr/0008-platform-declaration-pass-through.md`、`docs/adr/0009-posthub-owned-composition-seam.md`。

## 领域

PostHub 让短视频创作者「一个视频，一键或定时发布到抖音 / 小红书 / 微信视频号三个平台」，无人值守、静默执行。PostHub 是在 social-auto-upload **官方后端 + 官方前端功能**之上的**最薄封装**：发布引擎、登录态、账号存储、定时语义全部照官方实现，PostHub 只提供「对非程序员友好的桌面化界面」与「保证能运行」。

## 架构

- **形态**：Tauri 2 桌面应用（Windows/macOS 桌面窗口，**不常驻托盘**，点击关闭即退出）+ 官方 Python 后端（Flask，`sau_backend.py`）本地进程，前端通过 HTTP + SSE 调用。
- **前端**：React + Vite + shadcn/ui（Tailwind + Radix），自 Vue 3 + Element Plus 全量迁移（ADR-0003）。页面功能以官方 `sau_frontend` 为对照标准：发布（选视频/选账号/填信息/提交）、账号（扫码登录/校验/删除）、文件（上传/列表/删除）、定时、批量、cookie 导入导出。
- **发布引擎**：**官方后端的发布链路**（基于 social-auto-upload 的 `uploader/*`，patchright），**不 fork、不改官方源码**。官方 `sau_backend.py` 及其 `myUtils`（登录 / 发布 / 账号校验）作为上游 git 依赖引入（经 `uv`），桌面壳随应用启动官方后端进程。
- **组合层**：PostHub 通过独立组合入口把官方 Flask 应用与受限的 PostHub-owned 路由、数据库初始化、生命周期钩子组合起来；组合层不复制官方执行逻辑，也不改变官方接口的执行真源。
- **不造轮子**：凡官方已覆盖的功能（发布、登录、账号、定时、批量、cookie、文件）一律复用官方，不自研等价实现。**只有官方没有的功能才自研**；自研扩展必须保持在受限本机产品边界内。

## 核心概念（glossary）

| 术语 | 定义 |
|---|---|
| **官方后端** | social-auto-upload 自带的 Flask 服务 `sau_backend.py`（含 `myUtils` / `uploader/*` / `conf.py` / 自带 `database.db`）。提供 `/upload`、`/login`(SSE)、`/getValidAccounts`、`/postVideo` 等官方接口；副本仍注册 `/postVideoBatch`，但组合层固定返回 410，PostHub 批量只走 `/postRuns`。 |
| **官方前端** | social-auto-upload 自带的 `sau_frontend`（Vue 3）。PostHub 不直接使用，仅作为功能对照标准；PostHub 用 React 技术栈重写其功能。 |
| **桌面壳** | PostHub 的 React 前端 + Tauri 2 打包。负责桌面交互，并通过组合入口启动官方后端与受限本机扩展；**不常驻托盘，点叉即关**。 |
| **PostHub-owned 组合入口** | PostHub 侧唯一的后端组合边界：一次性初始化官方数据库、注册 PostHub-owned 路由与生命周期钩子，并返回可运行的官方 Flask 应用；重复调用必须幂等。它不替代官方发布执行，也不修改上游副本。 |
| **PostHub-owned 扩展** | 仅用于官方没有且桌面产品需要的本机能力（如账号默认声明、受限 batch runner/history）；扩展可持久化产品记录，但不成为通用调度器或发布执行真源。 |
| **账号 Account** | 官方后端 `user_info` 表 + `cookiesFile/*.json`（storage_state 格式）承载的登录态单元。每个账号 = 一个用户记录 + 对应 cookie 文件，无独立 Chrome 进程 / 无调试端口。 |
| **定时发布** | 官方后端 `/postVideo` 的 `enableTimer` 语义：`videos_per_day` / `daily_times` / `start_days`。 |
| **seam** | 前端 ↔ 官方后端的 **HTTP / SSE 接口契约**（`/upload`、`/login`、`/postVideo` 等）。一切自研前端功能必须落在该 seam 之上。 |
| **平台** | 抖音 `douyin` / 小红书 `xiaohongshu` / 视频号 `wechat`。官方后端用整型标识：1=小红书 2=视频号 3=抖音 4=快手。 |
| **桌面壳进程树** | 桌面壳 spawn 官方后端时的进程链：直接子进程 = `uv` trampoline（v0.1.4 起 `AppData\Roaming\com.posthub.desktop\venv\Scripts\python.exe`）；孙进程 = managed python（`AppData\Roaming\com.posthub.desktop\python\cpython-3.11...\python.exe`）；孙进程跑 `run_backend.py`。治理见 ADR-0007。 |
| **进程树清理** | 桌面壳在退出 / 启动两个时机的治理（ADR-0007）：退出用 `taskkill /F /T /PID <child.id()>` + `child.wait()`；启动前 `sweep_stale_daemons` 用 `sysinfo::System::new_all()` 枚举进程，过滤「`app_data_dir()/python` 路径前缀」+「cmdline 含 `run_backend.py`」双重条件后逐个 `taskkill /T` 杀树。 |
| **孤儿 daemon** | 桌面壳关窗口 / 崩溃 / 被强杀时，孙进程 managed python 因未被 spawn_daemon 的直接 `child.kill()` 覆盖而残留，**继续监听 5409**。每次重新打开 PostHub 都会刷一对新链路，**多次开关导致 N 对链路并存**，新链路因端口被占而抢不到连接——表现为扫码登录 SSE 一直 0 字节。 |
| **矩阵批量** | 「批量发布」区段的产品形态（issue #37/#38/#39）：每视频一条 BatchItem（独立标题 / 描述 / 标签 / 账号 / 定时模式），不再笛卡尔展开成「标题 × 账号」共享一份内容。提交时一行 BatchItem 展开为多条 PostVideoRequest（每账号一条），统一一次 POST `/postRuns` 受理；`/postVideoBatch` 仅保留 410 废弃边界。 |
| **受限本机 batch runner/history** | PostHub-owned 的产品扩展：只负责桌面端批量提交编排所需的本机记录、状态回看、受限 item retry 与恢复入口；实际执行由 run worker 按 effective 快照委托官方单 item `/postVideo` seam。它不提供通用任务调度、跨机器执行、限速/并发策略，也不替代官方定时语义。retry 只复制首次受理时冻结的 effective payload。 |
| **整批共用 dailyTimes** | 矩阵批量下，顶部 chip 池「每日时刻（HH:MM）」是整批共享的定时时刻池；每条 BatchItem 进入 timer 模式时必须从该池挑 1 个 timeOfDay（不能在 item 内自由输入），避免时刻分散在多条 item 上；`buildBatchItemsFromMatrix` 与 `/postRuns` effective 快照统一保持 HH:MM 分钟；视频号仅按平台注册表在 effective 中显式记录最近整点降级。 |
| **无 CLI** | PostHub 不发布命令行工具（`posthub` CLI / `ph` 子命令等）；所有交互走桌面壳 GUI。官方 `sau_backend.py` 仍由桌面壳作为子进程拉起（不在用户 shell 暴露）。PostHub 用户面对的「官方后端」只通过桌面壳的 HTTP/SSE seam 触达。 |
| **内容声明** | 各平台发布页要求创作者勾选/选择的合规标识字段，承载「是否 AI 生成 / 虚构 / 实拍 / 营销 / 转载 / 个人观点」等语义。三家平台 UI 字段名与候选文案均不统一。 |
| **平台声明字段** | 视频号「添加声明」8 选项 / 抖音「自主声明」单选 radio / 小红书「添加内容类型声明」单选 radio。PostHub **按平台分键透传**到 `platformFields.<platform>`，不抽象成统一键 —— 三家语义不对齐，统一键会丢精度。 |
| **`platformFields.<platform>`** | PostHub 任务级 JSON 字段，承载平台专属透传。键名沿用 glossary "平台"：`wechat` / `douyin` / `xiaohongshu`。当前可靠执行子键：`wechat.declaration`；`douyin.declaration`；`xiaohongshu.source`。`origin` 不在本版本可靠下发承诺内，传入即拒绝。 |
| **`declaration`（透传值）** | 视频号：`'no_label' \| 'ai_generated' \| 'fictional' \| 'personal_opinion' \| 'marketing' \| 'self_shoot' \| 'shoot_time_location' \| 'repost'`；抖音：`'ai_generated' \| 'personal_opinion' \| 'repost' \| 'marketing' \| 'fictional' \| 'no_need'`。PostHub 这层映射成上游能识别的中文文案（如 `'no_label' → "无需标注"`）。 |
| **`source`（透传值，小红书）** | `'fictional' \| 'ai_synthesized' \| 'marketing' \| 'self_declare'`（值随平台 UI 文案变更同步更新；上游无 source 字段代码，PostHub 用 DOM wrapper 处理）。 |
| **`origin`** | 「声明原创」开关，三家平台都有；PostHub 透传布尔，不参与合规声明语义。 |
| **平台默认声明** | 账号维度配置；批量场景下，未在任务表单覆盖时使用账号默认。**解决「批量发布全部被预选 AI 生成」痛点的关键开关**。PostHub 账号管理页提供默认声明设置入口。 |

## 平台约束注册表（已实测/调研）

| 平台 | 枚举值 | `min_lead_time` | 定时窗口 | 每日上限 | 封面 |
|---|---|---|---|---|---|
| 抖音 | `douyin` | 2h | 2h ~ 14 天 | — | 强制（自动选推荐封面） |
| 小红书 | `xiaohongshu` | **1h** | 2h ~ 7 天 | — | 缺封面自动取首帧 |
| 微信视频号 | `wechat` | 2h | 2h ~ 1 个月 | 本批次该账号累计定时任务数（UI 仅展示本批次，跨批次历史由官方兜底） | 缺封面自动取首帧；仅支持整点时由 PostHub 按最近整点降级，30 分钟向后并跨日进位 |

> 注：以上注册表来自历史调研，官方后端的实际定时约束以官方实现为准；自研前端不重复实现这些约束的校验，违规由官方返回错误。

## 状态与调度

- **不建立通用自研任务状态机 / 调度器 / 限速 / 并发控制**（ADR-0006 的绝对表述由 ADR-0009 收窄）。允许受限 item retry：仅从持久化 run 复制 failure/skipped/interrupted item 的 effective 快照，不重新合并账号默认。任务提交后仍委托官方后端执行（`/postVideo` 立即返回，实际发布在官方线程内进行）。
- 允许存在**受限本机 batch runner/history**：它只服务桌面端批量提交的本机记录、历史回看与恢复，不跨机器、不定义独立发布执行或通用 scheduler；官方接口与定时语义仍是真源。
- `/postRuns` 一次受理多条账号粒度 effective item；run worker 逐项委托官方 `/postVideo`。`/postVideoBatch` 不再是产品发布 seam，固定返回 410；定时用 `enableTimer`，最终状态由 run/item 查询真源提供。

> **边界修订（supersede）**：ADR-0006 早期“没有自研后端/状态机”的绝对表述，仅表示 PostHub 不建立通用发布执行引擎；现由 ADR-0009 明确允许受限本机组合扩展，同时保留官方执行真源与不 fork 上游约束。

## 命名与数据约定

- PostHub 侧不再维护 `task` / `platform_job` / `account` / `batch` SQLite 表作为执行真源（ADR-0001 的通用自研引擎已废弃）；登录态与文件元数据由官方 `database.db`（`user_info` / `file_records`）承担。受限本机 batch runner/history 如需记录，必须明确属于产品扩展，不得替代官方执行真源。
- 平台枚举命名（CONTEXT.md 层）：`douyin` / `xiaohongshu` / `wechat`。对接官方后端时映射到官方整型（1=小红书 2=视频号 3=抖音 4=快手）。
- 所有 Python 用 `uv` 管理，不用裸 pip / venv。
- 官方代码（`uploader/*`、`sau_backend.py`、`myUtils`、`sau_frontend`）不 fork、不改；PostHub 只通过独立组合入口在官方 Flask 应用外注册受限扩展，并在 HTTP/SSE seam 与桌面壳侧包一层。

## 内容声明透传（seam 扩展示例）

| 平台 | UI 字段 | PostHub 透传键 | 取值（内部枚举） |
|---|---|---|---|
| 视频号 `wechat` | 添加声明 8 选项 | `platformFields.wechat.declaration` | `no_label` / `ai_generated` / `fictional` / `personal_opinion` / `marketing` / `self_shoot` / `shoot_time_location` / `repost` |
| 抖音 `douyin` | 自主声明 6 选项 | `platformFields.douyin.declaration` | `ai_generated` / `personal_opinion` / `repost` / `marketing` / `fictional` / `no_need` |
| 小红书 `xiaohongshu` | 添加内容类型声明 | `platformFields.xiaohongshu.source` | `fictional` / `ai_synthesized` / `marketing` / `self_declare`（上游无 source 字段代码，PostHub 用 DOM wrapper） |
| 任一平台 | 声明原创 `origin` | 不提供可靠下发 seam | 本版本传入即拒绝，不制造可靠承诺 |

> 上游 `social-auto-upload/uploader/*` 当前支持度（实测 2026-08-21）：抖音 `declaration` 全链通；视频号仅尝试回避项（候选列表不含 "无需标注"，需 PostHub wrapper 扩列）；小红书 `source` 无代码。详见 `docs/research/2026-08-21-three-platform-aigc-declaration-fields.md`。

## 待验证项（真实账号实测后回填）

- 平台边界值（A 组遗留，未实测，保留为已知未确认值）：视频号单日上限（UI 侧以本批次累计 5 条为软提示阈值 `warn`/`warn-deep`，仅展示不拦截；跨批次历史由官方兜底校验）；抖音时长/视频号大小/小红书缺封面取首帧等官方实际约束。
- 官方后端线程模型在桌面壳内的稳定性：`sse_stream` 轮询式 SSE、`run_async_function` 每路事件循环、`MAX_CONTENT_LENGTH=160MB`、默认 `host=0.0.0.0:5409` 的暴露面是否需要改为仅本机。
- 官方 `database.db` 初始化时机与首次运行引导（官方要求手工建库/删建，封装时做成首次启动自动建库）。

## 历史备注（不再适用）

- 此前的「唯一注入面 = CDP 接管（patch `chromium.launch`→`connect_over_cdp`）」「账号 = 独立本机 Chrome + 独立调试端口」**已随 ADR-0006 废弃**。原因：视频号发布页在 CDP 连接存续期间不渲染发布编辑器，导致 `set_input_files` 超时；改为官方原生链路（自起浏览器 + storage_state 注入）即规避，且不再维护独立 Chrome/调试端口/多进程堆积的复杂度。