# ADR-0001:任务与 SQLite 数据模型

- **状态**：已批准（wayfinder ticket #5「设计任务与 SQLite 数据模型」）
- **日期**：2026-08-06
- **范围**：执行规范，不改代码。Phase 1 脚手架与调度器实现的依据。

## 背景

PostHub 一次发布动作会展开为 N 个平台子任务（D7），需要一套持久化模型来承载任务、平台子任务、账号、批次与日志，并支撑调度器（并发 2-3、同平台串行、限速 5 分钟）、重试（网络类重试 2 次退避、风控类转人工，D8）与兜底（验证码挂起、失效重登，D9）的运行。

## 设计输入

| 来源 | 结论 |
|---|---|
| D5 账号模型 | 每账号 = 本机 Chrome（独立 `user-data-dir`）+ 独立调试端口，`connect_over_cdp` 接管，登录态天然持久化 |
| D7 任务模型 | 发布任务 → N 平台子任务；任务管理页筛选/编辑/查看各平台明细 |
| D8 并发 | 同平台串行、跨平台并行 2-3、限速 5 分钟；网络类重试 2 次退避、风控类转人工 |
| D9 兜底 | 验证码挂起 + Tauri 弹窗；失效重登；强风控平台默认可见浏览器 |
| T1 (#2) | 不 fork 接入 = 调用方 patch `chromium.launch`→`connect_over_cdp`；PostHub 需自备 `conf` 模块；Phase 2 处理 `browser.close()` |
| T2 (#3) | 定时双模式：`publish_mode = platform_time`（平台原生定时，主流）/ `local_time`（工具到点，兜底）；`min_lead_time=2h`、`max_scheduled_per_day=5`（待实测） |
| T3 (#4) | 单发布表单 + 按渠道条件显示；各平台标题/标签/封面/专属字段差异 |

## 决策

1. **五张表**：`task`（发布任务）、`platform_job`（平台子任务）、`account`（账号）、`batch`（批次，可选）、`log`（日志）。
2. **时间统一存本地时间 ISO8601 字符串**（`YYYY-MM-DD HH:MM:SS`）。国内单时区、无 DST，本地时间最直观；若未来多时区再迁 UTC。调度器比较时统一解析为 datetime。
3. **task 持共享源值，platform_job 持平台最终值**。task 的标题/正文/标签/封面/排期是「源」，job 存该平台实际使用的值（可能被截断/平台专属覆盖，见 T3）。
4. **排期字段 task 级默认 + job 级可覆盖**。`schedule_policy` / `publish_mode` / `publish_at` 放 task，job 上同名列可空，空则继承 task。
5. **`task.status` 为聚合冗余列**，由服务层在子任务状态变更的同一事务里重算（规则见 §状态机），便于任务管理页无 join 过滤。
6. **多值字段用 JSON TEXT 列**（tags / image_paths / platform_fields），第一批不做过度规范化。
7. **job 冗余 `platform` 列**（与 `account.platform` 恒等），使调度 frontier 查询免 join；约束记录为不变量。

## 数据模型

### account（账号）

一个账号 = 单平台 + 一台本机 Chrome（独立 profile 目录 + 独立调试端口）。

```sql
CREATE TABLE account (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    platform      TEXT    NOT NULL CHECK (platform IN ('douyin','xiaohongshu','wechat')),
    name          TEXT    NOT NULL,                     -- 显示名/备注
    profile_dir   TEXT    NOT NULL,                     -- Chrome user-data-dir 绝对路径
    cdp_port      INTEGER NOT NULL,                     -- 独立调试端口，cdp_url = http://127.0.0.1:{cdp_port}
    chrome_path   TEXT,                                 -- 可选；固定 Chrome/Edge 可执行文件路径（T1 风险）
    status        TEXT    NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','needs_relogin','disabled')),
    last_login_at TEXT,
    last_publish_at TEXT,                               -- 限速 5 分钟的判定依据
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (platform, cdp_port)
);
```

- `status`：`active`（可用）/ `needs_relogin`（需重新扫码，由任务流转或用户手动置位）/ `disabled`（停用，调度器不领取）。
- 登录态失效的具体检测信号（脚本如何判定需重新扫码）尚未设计，见 §待验证项；job 流转到 `needs_relogin` 时服务层应顺带把账号置为 `needs_relogin`。

### batch（批次，可选）

文件夹 + `manifest.json` 的批量导入单元（D10）。

```sql
CREATE TABLE batch (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    folder_path   TEXT    NOT NULL,
    manifest_path TEXT,
    status        TEXT    NOT NULL DEFAULT 'imported'
        CHECK (status IN ('imported','in_progress','done','partial','failed')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
```

### task（发布任务）

一次发布动作。持有共享素材与默认排期。

```sql
CREATE TABLE task (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id         INTEGER REFERENCES batch(id),      -- 可空：手动单发
    title            TEXT    NOT NULL,                  -- 任务显示名（管理页）
    media_type       TEXT    NOT NULL DEFAULT 'video'
        CHECK (media_type IN ('video','note')),
    video_path       TEXT,                              -- 视频模式素材
    image_paths      TEXT,                              -- JSON 数组；图文模式图片组
    caption          TEXT,                              -- 正文/描述（共享源值）
    tags             TEXT,                              -- JSON 数组（共享源值）
    cover_horizontal TEXT,                              -- 横版封面（可选）
    cover_vertical   TEXT,                              -- 竖版封面（可选）
    schedule_policy  TEXT    NOT NULL DEFAULT 'immediate'
        CHECK (schedule_policy IN ('immediate','scheduled')),
    publish_mode     TEXT    NOT NULL DEFAULT 'platform_time'
        CHECK (publish_mode IN ('platform_time','local_time')),
    publish_at       TEXT,                              -- scheduled 时必填；本地时间 ISO8601
    silent           INTEGER NOT NULL DEFAULT 0,        -- 静默发布（不打扰，D6「静默/定时」开关）
    status           TEXT    NOT NULL DEFAULT 'pending',-- 聚合状态，见 §状态机
    created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
```

### platform_job（平台子任务）

task 展开的单个平台执行单元。状态机与调度器的核心载体。

```sql
CREATE TABLE platform_job (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    account_id       INTEGER NOT NULL REFERENCES account(id),
    platform         TEXT    NOT NULL CHECK (platform IN ('douyin','xiaohongshu','wechat')),
    status           TEXT    NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','publishing','success','failed','manual','needs_relogin','missed')),
    -- 排期覆盖（可空 = 继承 task）
    schedule_policy  TEXT,
    publish_mode     TEXT,
    publish_at       TEXT,
    -- 平台最终发布值（T3：截断/专属覆盖后的实际值）
    title            TEXT,
    caption          TEXT,
    tags             TEXT,                              -- JSON
    cover_horizontal TEXT,
    cover_vertical   TEXT,
    platform_fields  TEXT,                              -- JSON：平台专属（合集/原创声明/内容声明/短标题等）
    -- 发布结果
    post_id          TEXT,                              -- 平台返回标识
    post_url         TEXT,                              -- 发布后的链接
    -- 重试与错误
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    last_error_type  TEXT
        CHECK (last_error_type IN ('network','auth','risk_control','platform_reject','unknown')),
    -- 调度控制（并发抢占用）
    locked_at        TEXT,
    locked_by        TEXT,
    -- 时间戳
    created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    started_at       TEXT,
    finished_at      TEXT,
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (task_id, platform, account_id)
);

-- 不变量：job.platform == account.platform
```

- `UNIQUE (task_id, platform, account_id)`：默认一个 task 每平台一个 job；同一平台若指定多个账号，允许同平台多 job（仍受「同账号串行」约束）。
- `last_error_type` 驱动重试策略（§调度接口）。NULL 表示无错误。

### log（日志）

本地应用内日志（D11）。

```sql
CREATE TABLE log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER REFERENCES task(id) ON DELETE CASCADE,       -- 删任务连带清理其日志
    job_id     INTEGER REFERENCES platform_job(id) ON DELETE CASCADE,
    level      TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
    source     TEXT NOT NULL,                          -- scheduler / uploader / user / daemon
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

### 索引

```sql
CREATE INDEX idx_job_status_publish ON platform_job(status, publish_at);
CREATE INDEX idx_job_account_status ON platform_job(account_id, status);
CREATE INDEX idx_job_task ON platform_job(task_id);
CREATE INDEX idx_log_job ON log(job_id);
CREATE INDEX idx_log_created ON log(created_at);
```

## 状态机

### platform_job 状态

```
                 ┌─────────────┐
        ┌───────▶│   pending   │◀──────────────┐
        │        └──────┬──────┘               │
        │   领取        │                      │
        │               ▼                      │
        │        ┌─────────────┐  手动重试      │
        │        │ publishing  │───────────────┘
        │        └──┬───┬───┬──┘
        │  成功     │   │   │  失败/拒绝
        │           │   │   ▼
        │           │   │  failed
        │           │   ▼
        │           │  manual ──────────────┐
        │           │   (验证码/风控)        │ 人工处理后重试
        │           ▼                       ▼
        │        needs_relogin ──────────> publishing
        │           (登录态失效)
        │
        └── 定时窗口错过（missed 判定）
```

**状态定义与触发**：

| 状态 | 含义 | 进入方式 |
|---|---|---|
| `pending` | 待发布 | 任务创建即置；或手动/自动重试时由终态复位 |
| `publishing` | 进行中 | 调度器领取（pending→publishing，含 attempt_count+1） |
| `success` | 已完成 | 上游 `upload()` 成功返回，记录 `post_id` / `post_url` |
| `failed` | 失败 | 网络类重试用尽；平台拒绝且不可降级；超时 |
| `manual` | 需人工 | 验证码挂起（D9）、风控拦截 → Tauri 弹窗 |
| `needs_relogin` | 需重新扫码 | 登录态失效错误（`auth`）→ 顺带置账号 `needs_relogin` |
| `missed` | 错过 | 定时到点但未在容忍窗口内开始（本机离线/调度阻塞） |

**迁移规则**：
- `pending → publishing`：仅调度器，乐观锁抢占（见 §调度接口）。
- `publishing → success / failed / manual / needs_relogin`：上传结果分类（§重试）。
- `failed / manual / needs_relogin → pending`：用户手动重试（终态统一复位为 pending，再进入调度）；重试次数保留。
- `pending → missed`：`publish_at` 已过且超过容忍窗口仍未领取（`local_time` 定时、机器离线典型场景）。
- `publishing → missed`：超过超时阈值无心跳（近似 `updated_at` 超过 N 分钟），调度器兜底标记。

### task 聚合状态（服务层按序判定）

```
若 全部 job = success                      → success
若 全部 job = missed                        → missed
若 存在 job = needs_relogin                → needs_relogin
若 存在 job = manual                        → manual
若 无 job = success 且 存在 job = failed     → failed
若 存在 job in (pending, publishing)        → publishing
若 存在 job = success 且 存在失败终态        → partial
否则（全部 pending）                        → pending
```

判定顺序即优先级；实现为纯函数 `derive_task_status(jobs)`，在任一 job 状态变更事务内重算并回写 `task.status`。

## 调度 / 重试 / 限速接口

### 调度器 Frontier 查询（取可领取的 job）

```sql
SELECT j.*
FROM platform_job j
JOIN account a ON a.id = j.account_id
WHERE j.status = 'pending'
  AND (j.publish_at IS NULL OR j.publish_at <= :now)      -- immediate 或已到窗口
  AND a.status = 'active'
  AND j.account_id NOT IN (                               -- 同账号串行：同一账号无 publishing
      SELECT account_id FROM platform_job
      WHERE status = 'publishing'
  )
  AND j.id = (SELECT MIN(j2.id) FROM platform_job j2       -- 同账号内按创建序排队
              WHERE j2.account_id = j.account_id
                AND j2.status = 'pending')
  AND (a.last_publish_at IS NULL OR                        -- 限速：距上次发布 ≥ 5 分钟
       :now - a.last_publish_at >= 300)
ORDER BY (j.publish_at IS NULL) DESC, j.publish_at ASC, j.id ASC
LIMIT :concurrency;                                        -- concurrency = 2~3（跨平台并行）
```

- 同账号串行 = 同平台串行（账号绑定单平台，D8）。
- `LIMIT 2~3` 实现跨平台并行上限（D8）。

### 领取（乐观锁，防并发双领）

```sql
BEGIN;
  UPDATE platform_job
     SET status='publishing', locked_at=:now, locked_by=:scheduler_id,
         started_at=:now, attempt_count=attempt_count+1, updated_at=:now
   WHERE id=:job_id AND status='pending';
  -- 影响行数 = 0 ⇒ 已被并发领取，跳过
COMMIT;
```

发布成功/失败后在同一个事务里更新 job 终态并重算 task.status、回写 account.last_publish_at。

### 重试策略（按 last_error_type）

| 类型 | 判定信号（上传器抛错分类） | 处置 |
|---|---|---|
| `network` | 网络/连接/超时 | 自动重试：`attempt_count < 2` 时退回 `pending`（指数退避 30s → 2min）；用尽 → `failed` |
| `auth` | 登录态失效（401/扫码过期等） | → `needs_relogin`，Tauri 弹窗要求重新扫码；账号置 `needs_relogin` |
| `risk_control` | 风控拦截 | → `manual`（D9：强风控平台默认可见浏览器，用户确认后重试） |
| `platform_reject` | 平台拒绝（如定时前置不足 2h） | 若 `publish_mode=platform_time` 且可降级 → 提示改用 `local_time` 或立即发布（T2 场景 A）；否则 `failed` |
| `unknown` | 其他 | → `manual` |

### missed 判定

- `local_time` 定时：`publish_at` 已过且超过容忍窗口（默认 10 分钟）仍 `pending` → `missed`。由调度器 tick 扫描。
- 兜底：任何 `publishing` 状态超过超时阈值（默认 30 分钟，按 `updated_at` 判定）→ 标记 `missed`（记录日志）。

### 上传执行（与上游对接）

```python
# 伪代码：服务层构造上游参数 → cdp_attach(account.cdp_port) 注入 → upload()
async def execute(job, account):
    app = build_uploader(job.platform, job)          # DouYinVideo / XiaoHongShuVideo / TencentVideo
    async with cdp_attach(f"http://127.0.0.1:{account.cdp_port}", is_local=True) as pw:
        await app.upload(pw)                          # 上游 100% 编排（T1 方案 B）
    # 成功后回填 job.post_id / post_url；异常按 last_error_type 分类
```

- PostHub 需提供名为 `conf` 的模块（6 符号：`BASE_DIR / DEBUG_MODE / LOCAL_CHROME_HEADLESS / LOCAL_CHROME_PATH / XHS_SERVER / YT_PROXY`，T1），否则上游 `import conf` 即崩。
- Phase 2 在 wrapper 内 patch `browser.new_context`→`contexts[0]` 并中和 `browser.close()`（T1），数据模型无需改动。

## 待验证项与后续

- 登录态失效检测信号（job/账号判定 `auth` 的具体触发点）——真实账号实测后设计。
- `max_scheduled_per_day=5`（视频号单日预发布上限）——待实测，影响批量排期是否触发降级。
- 三平台视频大小/时长真实上限（T3 需实测回填）——发布表单校验用，不涉 schema 变更。

## 决策权衡记录

- **时间存本地而非 UTC**：国内单时区、无 DST，本地时间直观且避免转换错误；多时区需求出现时再整体迁移，属一次迁移而非结构性缺陷。
- **task 源值 + job 最终值双份**：换来的是「任务管理页看到的是该平台实际发布的值」这一产品要求，代价是轻微冗余。
- **task.status 冗余列**：避免每次过滤 join + 聚合；由服务层维护，约束了写路径必须在同一事务内更新（已在 §领取 固定）。
- **多值字段 JSON 列**：tags / platform_fields 为一次性写入、整体读取，无关联查询需求，规范化只增加成本。
