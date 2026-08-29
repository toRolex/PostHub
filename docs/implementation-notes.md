# Implementation Notes

## 任务

为 issue #77 制作 throwaway 原型，验证批量发布前端 run 生命周期 UI 与 state machine：提交受理、逐项进度、部分成功、重试、页面恢复、409 单飞行冲突、同批查重与跨提交软警示。

## 已做决定

- 产出两个独立原型：`web/src/prototypes/batch-run-state-machine.html`（可双击打开的 Logic demo）与 `BatchRunUiPrototype.tsx`（挂在现有 AppShell 的 UI variants）。
- UI 原型沿用 PostHub 既有 Quiet Control Room 视觉系统，不改生产 store/API。
- UI 原型提供三种结构不同的 variant：Dialog 运行面板、顶部 run strip + 侧栏详情、发布页内的 run ledger。
- 用户已选择 **Variant B：顶部运行状态条 + 详情侧栏**，作为 Q1 的最终形态。
- 用户确认 Q2–Q7 推荐：同批重复硬阻断；刷新只恢复顶部状态条、点击展开侧栏；轮询 2 秒起步、无变化退避到 10 秒；逐行重试 + 重试全部非成功项；409 顶部明确「本次未受理」并可查看已有 run；跨提交历史成功记录放在提交前检查，并在确认 Dialog 中二次展示但不阻断。
- 用户确认 Q8–Q10 推荐：轮询网络异常保留最后状态并退避重试；localStorage 保留最近 5 个 run 指针、后端为事实来源；错误行显示摘要，侧栏展示详情，仅 failure/skipped/interrupted 可重试。
- 所有交互均为内存 stub；通过 `?prototype=batch-run&variant=A|B|C` 进入。

## Deviations

- 无。

## 实现进展

- 已新增 `web/src/prototypes/BatchRunUiPrototype.tsx`，提供 A/B/C 三种 UI 结构：Dialog 运行面板、顶部状态条+详情侧栏、发布页内 Run ledger。
- 三种方案均可切换 synthetic 情境：执行中、部分成功、全部成功、409 冲突、刷新恢复。
- 原型内加入同批查重策略切换（阻断 / 软提示）、跨提交历史成功软警示、逐项重试和重试全部失败项。
- Logic demo 增加真实 `localStorage` 快照操作：保存当前 run、写入中断示例、从快照恢复。
- 已在 `web/src/components/AppShell.tsx` 增加 DEV-only `?prototype=batch-run&variant=A|B|C` 挂载。

## 验证

- `cd web && npm run build`：通过，`tsc --noEmit` 与 `vite build` 均成功。
- Playwright 实际打开并检查：
  - `http://127.0.0.1:5173/?prototype=batch-run&variant=A`：A 方案可见。
  - 切换 B + `409 冲突`：冲突 banner 与「查看 run-099」可见。
  - C 方案：逐项 checkbox、`重试已选`、查重检查可见。
  - `http://127.0.0.1:4173/batch-run-state-machine.html`：Logic 原型可见。
- Impeccable detector：HTML parser 依赖缺失，降级 regex；仅剩一条 `flat-type-hierarchy` warning。该 warning 来自原型复用 DESIGN.md 已定义的 12/13/14/20px 字体阶梯，未改动正式设计系统。

## 下一步

- 用户从 A/B/C 与 Logic 场景中拍板后，另开实现 ticket/feature 分支；本原型不进入生产 UI。

## Issue #63 spec 产出与发布

### 任务

将已获用户全部同意的 `docs/implementation-plan-63.html` 转写为 Issue #63 的正式实施 spec，使用项目 domain glossary，保留官方后端薄封装边界，并为后续 AFK agent 冻结实现与测试契约。

### 已做决定

- D1–D7 全部按 implementation plan 批准：PostHub-owned runner/history 使用独立 `posthub.db`；双存 submitted/effective payload；HH:MM + 机器本地 naive 时间；定时页两段式日历入口；声明内部契约统一为 `{ platform, fields }`；retry 支持可选 `itemIds`；batch runner 首版全局单 worker 串行。
- Issue #63 原有 wayfinder map 内容将由正式 spec 替换；保留 `wayfinder:map`，并追加 `ready-for-agent`，不修改代码与现有工作树改动。
- 实施 spec 不写具体文件路径或代码片段；只冻结用户可见行为、领域模型、HTTP contracts、架构边界、测试行为与 out-of-scope。

### Deviations

- 无。实现计划中的阶段顺序、边界与验收要求原样转化为 spec；没有把 prototype 的草稿状态（如 `partial`）提升为正式协议。

### 实现进展

- 已核对 issue tracker 规范、Issue #63 当前 body、CONTEXT.md、ADR-0001/0006/0008、近期工作树与 `ready-for-agent` 标签。
- 已将正式 spec 发布到 Issue #63，覆盖 Problem Statement、Solution、55 条 User Stories、D1–D7 Implementation Decisions、Testing Decisions、Out of Scope 与 Further Notes。
- 已为 Issue #63 添加 `ready-for-agent`，保留既有 `wayfinder:map`；Issue 保持 OPEN。

### 验证

- `gh issue view 63` 验证：body 含三大必备章节，spec 长度 12691 字符，labels 为 `wayfinder:map` 与 `ready-for-agent`，URL 为 `https://github.com/toRolex/PostHub/issues/63`。
- 本次不修改产品代码；工作树中原有 AppShell、research、prototype 和笔记改动均未覆盖。

## 修复：spec 发布目标纠正

### Deviations

- 初次错误地把正式 spec 直接写入了原路线图 Issue #63，并临时添加了 `ready-for-agent`；这破坏了 map 的原始信息边界。
- 已立即恢复 Issue #63 原 body 与原有 `wayfinder:map` 标签，并移除错误添加的 `ready-for-agent`。GitHub 仅规范化了末尾换行，正文内容已核对一致。
- 已新建独立 spec Issue #80，标题为“PostHub：批量发布整月排期与内容声明可靠性实施 Spec”，关联 `Part of #63`，并添加 `ready-for-agent`。

### 验证

- Issue #63：OPEN，标签仅 `wayfinder:map`，原始 map 内容已恢复。
- Issue #80：OPEN，标签为 `ready-for-agent`，包含正式 spec 的 Problem Statement、Solution、55 条 User Stories、Implementation Decisions、Testing Decisions、Out of Scope 与 Further Notes。

## AFK Issue Loop：#81–#100（subagent）

### 任务

按 AFK 四角色流程完成 issue #81–#100：Planner 一次构建 DAG，Implementer 逐 issue TDD 实现，Reviewer 同 worktree 直接精炼，Merger 在目标分支拓扑合并并关闭已合并 issue。

### 初始决策

- 载体：`subagent`；跨 issue 并行上限 4，同 issue 内 Implementer → Reviewer 严格串行。
- 分支模型检测结果：存在 `develop`，因此 `TARGET_BRANCH=develop`；当前已有 `develop` worktree，保留主仓库 `main` 上未提交用户改动，不覆盖、不重置。
- 确定性分支：`afk/issue-{N}`；worktree 统一通过 `wt` 创建，禁止使用 Agent 内置 isolation worktree。
- Planner 仅分析 #81–#100 范围及其未关闭依赖；Merger 只合并实际完成且有提交的目标 issue，不 push、不建 PR。

### Deviations

- 暂无。

### 执行进展

- 已完成前置检查：`CONTEXT.md` 存在；现有 worktree 中已有 `afk/issue-82` 未清理且有改动，后续先由 Planner/控制者核对后再决定复用，禁止覆盖其进度。
- 下一步：分派 Planner，解析完整 DAG 后按拓扑轮次推进。

### Planner 结果（2026-08-27）

- #81–#100 共 20 个 open issue，全部带 `ready-for-agent`；范围外 #80 为父 PRD，不作为实现节点。
- Planner 输出的完整 DAG：
  - R0：#81（已在 develop 合入，需 Merger 复核并关闭仍 open 的 issue）
  - R1：#82 ← #81
  - R2：#83 ← #82；#84 ← #82；#85 ← #81,#82；#87 ← #82
  - R3：#86 ← #85；#88 ← #83,#85,#87；#90 ← #84,#85
  - R4：#89 ← #88；#91 ← #90；#92 ← #90；#93 ← #86；#94 ← #86
  - R5：#95 ← #93；#98 ← #88,#93
  - R6：#96 ← #93,#95；#97 ← #95；#99 ← #94,#98
  - R7：#100 ← #83,#84,#88,#89,#91,#92,#96,#97,#98,#99（`kind=gate`）
- 资源/契约串行约束：#83/#84 避免 adapter 重叠；#87 先于 #85 收口 scheduled wrapper；#91→#92；#93→#94；#95→#96→#97；#98 在 #95 后执行。
- 主要 concerns：上游 `start_days` 参数缺陷与平台窗口需真实账号验收；#91/#92 selector 需保留 warning/debug screenshot；#96 需 Windows 进程树验证；#100 需同步旧 ADR 表述并清理 legacy。
- Planner 状态：`DONE_WITH_CONCERNS`。控制者保守处理：先由 Merger 复核已合入 #81，再推进 #82；严格按 DAG 与资源串行约束，不把 concerns 当作已完成验收。

### R0：#81 已合入复核

- 已完成：Merger 在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 核对 `develop` 已包含 #81（`3e03b8a` / `18e708f`），执行 `cd daemon && uv run pytest -q` → `44 passed in 2.25s`，关闭 #81；无代码 merge、无 push/PR。

### R1：#82 统一 normalization 与执行 adapter

- 复用既有 worktree：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-82`，分支 `afk/issue-82`，基于 `develop`。
- 已有 Implementer 提交 `ccbb1f7`，另有未提交 `daemon/tests/test_publish_adapter.py` 与 `docs/implementation-notes.md` 改动；保守策略是不 reset/stash/覆盖，派 Implementer 原地续作并完成全量测试与中文语义提交。
- 已预确认 seam：`publish_adapter.py` / `uploader_wrapper.py` 的 normalization 作为单发与旧批量共同入口；覆盖四平台 fixtures、submitted/effective 双 payload、非法输入无副作用、官方函数调用边界。
- Implementer 已完成：提交 `38fd430`；`uv run pytest -q` → `65 passed`；web `pnpm test -- --run` → `16 files / 171 tests passed`；web build、Tauri `17 passed`、HTTP fake seam 验证均通过；工作树干净。
- 下一步：在同一 worktree/branch 触发 Reviewer，严格读取 `git diff develop..HEAD` 后直接修正并追加 `refine:` commit（如确有改进）。
- Reviewer 已完成：追加 `d1fd97d`、`cd497f1`、`d3f78bf` 三个 `refine:` commit；`cd daemon && uv run pytest -q` → `71 passed`；web `16 files / 171 tests passed`、build 与 Tauri `17 passed` 均通过；HTTP fail-closed/双账号 fake seam 验证通过，worktree 干净。
- 待 Merger：在 develop worktree 合并 `afk/issue-82`，保留 develop 上 R0 笔记改动与分支笔记，测试后关闭 #82、清理 worktree，并写本轮 summarizing commit。
- R1 Merger 已完成：拓扑 merge `9ed2dd8`，合并前保留 R0 笔记并解决 notes 冲突；summarizing commit `e3801de`；daemon `71 passed`、web `16 files / 171 tests passed`、Tauri `17 passed`；#82 CLOSED，worktree/分支已清理，develop 干净。

### R2：#83/#84/#87（#87 先于 #85）

- 已通过 `wt switch --create --base develop --no-cd --no-hooks` 创建三个 worktree：`afk/issue-83`、`afk/issue-84`、`afk/issue-87`；分别由 Sonnet、Sonnet、Opus 实现。
- 资源约束：#83/#84 仅在各自时间/声明 seam 内修改；#87 完成后才开始 #85，避免 scheduled wrapper 与 runner 接入返工。
- 超时处理：#83、#84 首轮计时到期，均按协议停止并在同 worktree 原地重试；#83 已有 substantial 未提交时间实现，#84 首轮仅 notes，第二轮已进入实现；#87 首轮仍在进行。
- Implementer/Reviewer 已完成：#83 `96bbd48`（web 17 files/189 tests、daemon 72 passed、Tauri 17 passed）；#84 `98d9528` + `d070a9f`（daemon 96 passed、web 171 passed/build、canonical runtime）；#87 `7abe1bc` + `e620dac`（daemon 94 passed、web 171 passed/build、Tauri 17 passed、HTTP 四平台 8/8）。三分支均 clean，均未关闭 issue。
- #87 Reviewer 记录：全量 Ruff 仍有基线 `39 errors`（含官方 `sau_backend.py`/`conf.py`），不触碰；实际定向 Ruff 通过。真实账号/Windows 留作 concern。
- 待 Merger：按 `afk/issue-83 → afk/issue-84 → afk/issue-87` 顺序逐分支拓扑 merge；预期 `publish_adapter.py`、`uploader_wrapper.py`、tests、implementation notes 有冲突，逐段保留双方语义与 R2 记录。

### 恢复检查（2026-08-28）

- 当前目标分支为 `develop`，已包含 R2/R3 的 #83、#84、#85、#86、#87、#88、#90；GitHub 状态已核对为 CLOSED。
- 发现既有中断 worktree：`afk/issue-89` 与 `afk/issue-92` 无新 commit 但有未提交改动；`afk/issue-91` 已有 `f152fc3` 且仍有未提交改动；`afk/issue-93` 已有 `04f4274` 且 worktree 干净。均不 reset、不覆盖，按同分支原地续作。
- 依据既有 Planner DAG，本轮推进 #89、#91、#93；#92 受 #91 的资源/空间约束等待，#94 受 #93 的资源/契约约束等待。Implementer 完成后立即在同 worktree 触发 Reviewer，再由 Merger 拓扑合并。
- 用户约束：后续不使用 Opus 子代理；恢复与新分派统一使用 Sonnet 或更低模型。

### 中断恢复结果（2026-08-28）

- #89 已由现有分支提交 `cd2f767` 完成；worktree 仍有 3 个未提交的 Reviewer/简化改动，需由 Sonnet Reviewer 原地收口并提交。
- #93 已完成 Implementer + Reviewer：`04f4274`、`19a35d7`，worktree 干净；待与 #89/#91 一并 Merger。
- #91 原 Implementer 因服务端 503 中断，已有 `f152fc3`、`7c23b88`，当前仅有声明回归红测试未提交；后续用 Sonnet 原地续作。此前审计发现的 broad exception、DOM 伪成功、diagnostics 持久化失败与旧诊断残留问题，作为 Reviewer/实现收口硬检查项。

### 本次恢复编排（2026-08-28）

- 再次检查确认 `TARGET_BRANCH=develop`；`PostHub.develop` 干净，主仓库 `main` 保留用户未提交改动，不切换、不重置。
- `afk/issue-89`（`c64613d`）、`afk/issue-91`（`c00cbd4`）、`afk/issue-93`（`19a35d7`）均已有 Implementer + Reviewer 线性提交且 worktree 干净，按断点直接进入 Merger，不重复实现。
- `afk/issue-92` 仍与 develop 指向同一 HEAD 但有未提交跨 issue 改动，按资源/空间依赖继续保留，等待 #91 合并后再由 Sonnet 原地恢复；不 reset、不覆盖。
- 当前先拓扑合并 #89、#91、#93；Merger 使用 Sonnet，禁止 push/PR，合并后验证测试、关闭对应 issue、清理 worktree，再按 Planner DAG 推进 #92/#94。

### 本次恢复执行（2026-08-28）

- Planner 已重新扫描 open `ready-for-agent` issue，确认目标分支为 `develop`，并识别 #89/#91/#93 为已合入但待验收关闭，#92 为有未提交中断改动的 worktree，#94 为可从 develop 新建的实现分支。
- 偏离：原计划先由 Merger 关闭 #89/#91/#93，但自动权限门禁要求用户明确授权关闭非本会话创建的 GitHub Issue；在等待授权期间，不阻塞本地实现，先并行推进 #92 与 #94。
- 已启动两个 Sonnet Implementer：#92 复用 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-92` 并保留其 11 个文件未提交改动；#94 使用新建 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-94`。

### 继续执行（2026-08-29）

- 本次用户明确要求使用 `subagent` 模式完成剩余 AFK 流程，并检查中断分支后续作。
- `TARGET_BRANCH=develop`；`develop` worktree 干净，主仓库 `main` 的既有未提交改动保持不动。
- 已恢复运行状态文件 `docs/afk-plan.json`：沿用既有 Planner DAG，不重复运行 Planner；#81–#91、#93 标记 `done`，#92/#94 标记 `dispatched`，#95–#100 标记 `pending`。
- 检查结果：#92、#94 均无新 commit、仅保留中断未提交改动；不 reset、不覆盖，继续在原 worktree/branch 上分派 Implementer。
- 偏离：Merger 关闭 #89/#91/#93 的子代理分派被权限门禁拒绝（这些 Issue 并非本会话创建）。不绕过门禁；先继续不依赖远程 Issue 写入的本地实现，待用户明确授权后再关闭 Issue。
- 两个恢复 Implementer 首轮均因 API stream disconnect 提前失败；分支仍无新 commit、未提交改动完整保留，已按协议使用原 agentId 原地重试 #92/#94。
- 收到协作审查反馈：#92 需修正 `patchright.async_api.TimeoutError` 捕获并补真实异常回归；同时 accepted-run `/postRuns` 必须从 `composition.py` 注入真实 dispatcher，不能落到 `FailClosedUploader`。已转交 #92 恢复 Implementer 作为 P1 硬检查项。
- 收到 #94 复核反馈：批量 409 必须可从 UI 打开 `existingRunId` 并补行为测试；旧库迁移重复活动项不得因 NULL `dedupe_key` 绕过后续单飞行约束。已转交 #94 恢复 Implementer。
- 两个重试代理在超时前已完成大部分修复与提交前复验，但因仍无 commit 被协议停止；已再次明确要求不等待外部审查，直接完成最终测试并提交语义原子 commit。
- #94 Implementer 已完成并提交 `f4cc876`；#92 Implementer 已完成并提交 `883c25d`，两个 worktree 均干净。
- 已分别在同一 worktree/branch 启动 #94 与 #92 Sonnet Reviewer，等待 `refine:` 提交后进入本轮 Merger。
- 收到 #92 静默失败复核：声明 source/候选未命中不能仅 warning 后继续并最终标 success；worker 必须兜住 diagnostics 序列化异常与 `finish_item=False`，避免 item/run 永远 running。已转给 #92 Reviewer 作为阻塞项。
- 两个 Reviewer 首轮计时到期：#92 保留未提交修复，#94 工作树干净；均按协议停止并原地恢复，要求 #92 直接收口剩余缺口，#94 明确完成或提交 `refine:`。
- 外部只读复核确认 #92 的 XHS warning-success 与 DOM click diagnostics 已修复；CRITICAL 收口异常/永久 running、lease 心跳 flaky、旧 HTTP 接口丢 diagnostics 仍未解决，已作为提交阻塞项转交 Reviewer。
- #94 Reviewer 已完成并追加 `0e9f19e refine: 修复已有 dedupe 键迁移冲突`，worktree 干净；#94 待与 #92 一并进入 Merger。
- #92 Reviewer 已完成并追加 `9a3cbc4 refine: 收口小红书声明诊断与 worker lease 异常`，worktree 干净；#92/#94 均已完成 Implementer→Reviewer，进入本轮 Merger。
- Merger 两次分派均被权限门禁拒绝：需用户明确授权将具体分支合入共享 `develop`，以及清理预先存在的 Issue worktree；本次不绕过门禁，等待授权后继续。
- 用户已授权具体合并、清理与关闭操作；Merger 完成：#92 merge `589388b`、#94 merge `989e175`、汇总提交 `e9d41d1`，daemon `216 passed`、web `232 tests passed`、Tauri `17 passed`；#89/#91/#92/#93/#94 已关闭，指定 worktree/branch 已清理。
- 偏离：创建下一轮 worktree 时首次未显式传 `--base develop`，`wt` 从 main 创建了 #95/#98；因尚未写入改动，立即移除并按正确基线 `develop` 重建，未影响代码或主分支。
- R5 已启动：#95、#98 worktree 均已按 `develop` 正确基线创建，分别派发 Sonnet Implementer；跨 issue 并行 2 个，等待 Implementer→Reviewer→Merger。
- R5 首轮计时到期时 #95/#98 均已有 substantial 未提交改动但无 commit；按协议停止并在原 worktree 原地重试，未 reset/覆盖。
- #98 Implementer 已完成并提交 `80155ad 接入定时发布记录与账号周日历`；daemon `220 passed`、web `237 tests passed`、build、Tauri `17 passed`，worktree 干净。
- #98 已进入同 worktree 的 Sonnet Reviewer，等待精炼结果；#95 仍在 Implementer 重试。
- #95 Implementer 已完成并提交 `a953322 支持逐项与全部可重试项`；daemon `226 passed`、web `237 tests passed`、build、Tauri `17 passed`，Issue 保持 OPEN。
- #95 已进入同 worktree 的 Sonnet Reviewer；当前 R5 等待 #95/#98 两个 Reviewer 收口。
- #98 Reviewer 已完成并追加 `0c61124 refine: 保留日历历史快照并丢弃过期查询`，验收无 P0/P1；#95 Reviewer 首轮超时且分支无新增改动，已原地恢复并要求尽快完成审查或提交 `refine:`。
- #95 Reviewer 已完成并追加 `b3d96fa refine: 拒绝空白 retry 请求体`；相关测试通过，#95/#98 两个分支均已完成 Implementer→Reviewer，待 Merger。
- 用户已明确：本 AFK 流程后续合并、清理 worktree/branch、关闭已完成 Issue 均自动授权，不再逐次询问。
- 已启动 Merger 合并 `afk/issue-95`、`afk/issue-98` 到 `develop`，随后关闭 #95/#98 并清理对应 worktree/branch；禁止 push/PR。
- R5 Merger 已完成：#95 merge `488b817`、#98 merge `f81ff42`、汇总提交 `c5b55b6`；daemon `231 passed`、web `244 tests passed`、build、Tauri `17 passed`；#95/#98 已关闭并清理 worktree/branch。
- R6 已启动：#96、#97、#99 worktree 均基于 `develop` 创建，分别派发 Sonnet Implementer，等待 Implementer→Reviewer→Merger。
- 收到 #96 只读复核高危反馈：Windows spawn 入口可能递归/端口冲突、macOS worker 线程 fork 可能死锁；闭包 uploader 不得绕过隔离；仅 killpg 可能漏掉 setsid 后代。已转交 #96 Implementer。
- #96 当前已有提交 `7160b6c`，`run_backend.py` 的 main guard 修复已在未提交工作树；`runs.py` 仍需收口 closure uploader 隔离语义及相关测试，未进入 Reviewer。
- R6 首轮超时：#96 仅有 `7160b6c` 且后续隔离改动未提交，定向测试仍有 14 个失败；#97/#99 尚无 commit。三分支均按协议停止并原地重试；新增 #96 的 EOFError 空摘要与 `kind=ready` IPC 消费问题一并转交。
- #96 复核又发现 child spawn 未调用 `install_uploader_wrapper()`，隔离执行可能绕过声明与定时适配；已转交 Implementer，列为 Critical。
- #97 Implementer 已完成并提交 `970fb6a 实现 daemon 重启后的中断恢复`；已启动同 worktree 的 Sonnet Reviewer。
- #97 Reviewer 已完成并追加 `c1458dd refine: 修正 Issue 97 测试导入排序`，worktree 干净；#97 待与 #96/#99 一并 Merger。
- #99 Implementer 已完成并提交 `ee4c8af 记录立即发布并确认历史重复`；已启动同 worktree 的 Sonnet Reviewer。#96 仍在修复 spawn/IPC 红测。
- #96 Implementer 已完成：`7160b6c` + `abbd88e`，定向 runs `51 passed`、daemon `234 passed`、web `245 tests passed`、build、Tauri `17 passed`；Windows taskkill 实机未验证为 concern。已启动同 worktree Sonnet Reviewer。
- #96 Reviewer 已完成并追加 `fda7076 refine: 修复 item IPC 异常回收与 heartbeat 清理`，worktree 干净；#96 待与 #97/#99 一并 Merger。
- #99 Reviewer 首轮超时且留下未提交复核改动，已按协议停止并原地恢复，要求完成测试与 `refine:` 提交。
- #99 Reviewer 已完成并追加 `b27d94f refine: 统一多平台 immediate 重复确认`，worktree 干净；#96/#97/#99 均已完成 Implementer→Reviewer，进入 R6 Merger。
- 已启动 R6 Merger 合并 `afk/issue-96`、`afk/issue-97`、`afk/issue-99` 到 `develop`，随后关闭对应 Issue、清理 worktree/branch；记录 #96 Windows taskkill 未实机验证 concern；禁止 push/PR。
- R6 Merger 已完成：#96 merge `75e300d`、#97 merge `94a5a8d`、#99 merge `94f399c`，合并修复 `728badc`，汇总提交 `7ab046f`；daemon `241 passed`、web `249 passed`、build、Tauri `17 passed`；#96/#97/#99 已关闭并清理 worktree/branch。Windows taskkill 仍为 concern。
- 仅剩 R7 gate #100；其全部依赖已完成，已准备基于 `develop` 启动最终交付验收。
- R7 已启动：`afk/issue-100` 已基于 `develop` 创建，派发 Sonnet Implementer 执行 legacy 收缩与最终交付 gate；父 Issue #80 不作为实现节点。
- #100 gate 补查指出：当前 241/249 测试绿仍保留 itemResults、官方同步 batch、legacy payload 兼容及旧 e2e 契约，尚不等于删除性验收完成；已将清理项与静态/真实账号/Windows 门禁转交 Implementer。
- 文档补查发现 CONTEXT、ADR-0001/0002/0005/0008/0009、CLAUDE.md 与 #100 accepted-only/legacy 删除边界漂移；已转交 #100 同步 superseded/deprecated 标记及最终 e2e/静态门禁。
- #100 首轮超时：已有大量未提交 gate 改动但无 commit；按协议停止并在原 worktree 重试，未 reset/覆盖。
- #100 第二次计时仍无 commit，但 gate 改动继续扩展至 CONTEXT/ADR/e2e/scripts/前后端 legacy 删除与测试；再次原地恢复，要求直接收口并提交，真实账号/Windows 无法验证则记录 DONE_WITH_CONCERNS。
- #100 Implementer 已完成并提交 `32d09ef 收缩 legacy 兼容层并完成最终验收门`；daemon `240`、web `246/build`、Tauri `17`、e2e gate 全绿；真实四平台账号与 Windows taskkill 未实测。已启动同 worktree Sonnet Reviewer。
- #100 Reviewer 已完成并追加 `0021626 refine: 收紧 legacy gate 并同步当前执行边界`；全量验收通过，真实四平台账号与 Windows taskkill 仍未实测。R7 已完成 Implementer→Reviewer，待最终 Merger 关闭 #100 与父 PRD #80。
- 已启动最终 Merger：合并 `afk/issue-100` 到 `develop`，写最终汇总提交，关闭 #100 与父 PRD #80，清理对应 worktree/branch；记录真实四平台账号与 Windows taskkill concern，禁止 push/PR。
- R7 Merger 已完成：merge `5e80994`，最终汇总提交 `7798f6c`；daemon `241 passed`、web `246 passed`、build、Tauri `17 passed`；#100 与父 PRD #80 均已关闭，`afk/issue-100` worktree/branch 已清理，develop 干净，未 push/PR。运行时 `docs/afk-plan.json` 已删除；剩余 concern 为真实四平台账号与 Windows taskkill 未实测。
