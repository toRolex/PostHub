# CONTEXT.md — PostHub（发布中枢）

> single-context 领域文档。术语与决策的唯一事实来源；改术语先改这里，再改代码。
> 决策细节见 `docs/adr/0001-task-and-sqlite-schema.md`、`docs/adr/0002-manifest-batch-format.md`。

## 领域

PostHub 让短视频创作者「一个视频，一键或定时发布到抖音 / 小红书 / 微信视频号三个平台」，无人值守、静默执行。逐平台手动发布耗时易错且易被平台风控，PostHub 用本机真实 Chrome 的登录态完成发布，降低封号风险。

## 架构

- **形态**：Tauri 2 桌面应用（Windows 托盘 / macOS 菜单栏常驻）+ 常驻 Python 守护进程，本地 IPC 通信。
- **前端**：Vue 3 + Vite + Element Plus + Pinia。
- **发布引擎**：基于 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（patchright），**不 fork**，经 `uv` 作为依赖安装；PostHub 自备 `conf` 模块提供上游依赖字段。
- **唯一注入面**：patch `chromium.launch` → `connect_over_cdp` 接管账号 Chrome，登录态天然持久化。
- **唯一 seam**：守护进程「任务执行引擎」接口 `execute(task_spec, context) -> job_updates`；浏览器执行器经依赖注入替换。调度 / 状态机 / 重试 / 限速 / 并发为纯领域逻辑；UI 与真实平台浏览器在 seam 之外。测试只断言 seam 外部行为（`task_spec` + fake 执行器 → `job_updates`）。

## 核心概念（glossary）

| 术语 | 定义 |
|---|---|
| **账号 Account** | 绑定单平台 + 单台本机 Chrome（独立 `user-data-dir` + 独立调试端口 `cdp_port`）。发布用 `connect_over_cdp` 接管该 Chrome。表：`account` |
| **任务 Task** | 一次发布动作，持有共享源值（标题/正文/标签/封面/默认排期），展开为 N 个平台子任务。表：`task` |
| **子任务 Job / platform_job** | task 展开的单个平台执行单元，持该平台最终值（可能被截断/覆盖）与状态机。表：`platform_job` |
| **批次 Batch** | 文件夹 + `manifest.json` 的批量导入单元，绑定一个账号；一次导入展开为多个 task，先进「待确认」再放行。表：`batch` |
| **CDP 接管** | `connect_over_cdp` 连接账号 Chrome 调试端口，复用其登录态；`browser.close()` 不得关闭真实 Chrome、不得掉登录态 |
| **conf 模块** | PostHub 自备的上游依赖配置（`BASE_DIR / DEBUG_MODE / LOCAL_CHROME_HEADLESS / LOCAL_CHROME_PATH / XHS_SERVER / YT_PROXY`），否则上游 `import conf` 即崩 |
| **Seam** | `execute(task_spec, context) -> job_updates`；调度/状态机为纯逻辑，浏览器经依赖注入 |
| **平台约束注册表** | 按平台注册的约束（min_lead_time、定时窗口、每日上限、封面要求），发布表单校验引用 |

## 平台约束注册表（已实测/调研）

| 平台 | 枚举值 | `min_lead_time` | 定时窗口 | 每日上限 | 封面 |
|---|---|---|---|---|---|
| 抖音 | `douyin` | 2h | 2h ~ 14 天 | — | 强制（自动选推荐封面） |
| 小红书 | `xiaohongshu` | **1h** | 2h ~ 7 天 | — | 缺封面自动取首帧 |
| 微信视频号 | `wechat` | 2h | 2h ~ 1 个月 | 5 条/日（工作值，待实测） | 缺封面自动取首帧 |

## 状态机

`platform_job.status`：

```
pending → publishing → success | failed | manual | needs_relogin
pending → missed（定时窗口错过）
failed / manual / needs_relogin → pending（手动重试，重试次数保留）
```

| 状态 | 含义 | 触发 |
|---|---|---|
| `pending` | 待发布 | 创建即置 / 重试复位 |
| `publishing` | 进行中 | 调度器领取（乐观锁，attempt_count+1） |
| `success` | 完成 | 上游 `upload()` 成功，回填 `post_id`/`post_url` |
| `failed` | 失败 | 网络重试用尽 / 平台拒绝不可降级 / 超时 |
| `manual` | 需人工 | 验证码挂起 / 风控拦截 → Tauri 弹窗 |
| `needs_relogin` | 需重新扫码 | 登录态失效（auth）→ 账号置 `needs_relogin` |
| `missed` | 错过 | 定时到点超过容忍窗口（默认 10min）未领取；或 publishing 超时（30min） |

`task.status` 为聚合冗余列，服务层按序判定：`success → missed → needs_relogin → manual → failed → publishing → partial → pending`，在 job 状态变更同一事务内重算。

## 调度与重试约束（seam 内的纯领域逻辑）

- **并发**：同平台（同账号）严格串行，跨平台并行 2–3 路；同账号内按创建序排队。
- **限速**：同一账号距上次发布 ≥ 5 分钟。
- **重试**（按 `last_error_type`）：

| 类型 | 处置 |
|---|---|
| `network` | 自动重试 `attempt_count < 2`（指数退避 30s → 2min）；用尽 → `failed` |
| `auth` | → `needs_relogin`，Tauri 弹窗重登，账号置 `needs_relogin` |
| `risk_control` | → `manual`（强风控平台默认可见浏览器，用户确认后重试） |
| `platform_reject` | `platform_time` 可降级则改 `local_time`/立即发布，否则 `failed` |
| `unknown` | → `manual` |

- **定时双模式**：`publish_mode = platform_time`（平台原生定时，主流）/ `local_time`（工具到点，兜底）。
- **排期字段**：task 级默认 + job 级可覆盖（空则继承 task）。

## manifest 批量导入（ADR-0002）

- 一个批次 = 一个账号下的若干视频；`manifest.json` 顶层 `{"version": 1, "videos": [...]}`。
- **manifest 不含账号/平台字段**——账号在导入 UI 选定，发布到该账号所属平台。
- 字段：`file`(必填) / `title` / `content` / `tags` / `cover_landscape` / `cover_portrait` / `schedule`。
- `schedule` 校验区间：**≥2h 且 ≤7 天**；超 7 天提示改立即发布，不足 2h 硬报错。
- 校验分级：导致发布失败 → 硬报错整批拒绝；平台静默截断/可兜底 → 软提示进待确认。
- 导入不直接排队，先进「待确认」逐条核对后再放行。

## 命名与数据约定

- 平台枚举：`douyin` / `xiaohongshu` / `wechat`。
- job 状态枚举：`pending` / `publishing` / `success` / `failed` / `manual` / `needs_relogin` / `missed`。
- 账号状态枚举：`active` / `needs_relogin` / `disabled`。
- 错误类型枚举：`network` / `auth` / `risk_control` / `platform_reject` / `unknown`。
- 时间统一存本地时间 ISO8601 字符串（`YYYY-MM-DD HH:MM:SS`），调度器比较时解析为 datetime。
- 表：`task` / `platform_job` / `account` / `batch` / `log`。不变量：`job.platform == account.platform`；`UNIQUE (task_id, platform, account_id)`。
- 所有 Python 用 `uv` 管理，不用裸 pip / venv。
- 平台 UI 自动化脆弱：改动前先查对应 `uploader/*` 当前结构；不直接修改上游源码，PostHub 侧包一层。

## 待验证项（真实账号实测后回填）

- 登录态失效的具体检测信号（脚本如何判定 `auth`）。
- 平台边界值（A 组遗留，未实测，保留为已知未确认值）：`max_scheduled_per_day=5`（视频号单日上限）最终值；抖音时长实测 60min vs 官方 15min；视频号大小实测 20GB vs 官方 2G；小红书缺封面取首帧、图片上限、视频时长/大小。
- Windows 真机（`--remote-allow-origins=*` CDP WebSocket 握手、同 user-data-dir singleton、Chrome 版本 vs patchright 1.58.2 兼容）：降级为已知风险，正式装机时验证。

## 实测结论（issue #11，验收门已关闭）

三平台自动化链路经视频号代表验证通过（CDP 接管 + 立即发布 + 定时排期）；小红书 / 抖音链路默认成功（同构 seam 外推，决策不实测）。实测接线要求：

- `BASE_DIR/utils/stealth.min.js` 必须存在（上游 `cookie_auth` → `set_init_script` 依赖）；从上游包复制到 `daemon/utils/`。
- 上传前需从 CDP context 导出 `storage_state` 到 `~/.posthub/cookies/{id}.json`：上游 `cookie_auth` 用自建 `async with async_playwright()` 新实例校验 `account_file`，绕过 `cdp_attach` patch（`uploader/tencent_uploader/main.py`）。
- 上游 uploader 发布成功不回填 `post_id` / `post_url`（待后续处理）。
