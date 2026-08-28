# Implementation Notes

## 任务

执行 AFK issue loop：处理 GitHub issue #81–#100。按 issue 依赖 DAG 分轮实现、审查，并将各 issue 分支仅在本地拓扑合并到 `develop`；全部完成后由用户自行创建回到 `main` 的 PR。

## 已做决定

- 用户明确要求使用新的 `develop` worktree，即使仓库此前只有 `main`；本流程不推送、不创建 PR。
- `develop` 从 `main` 最新已提交基线 `9bd651d864367ea1dd5119970f6e4346c4901b28` 创建，避免带入 `main` worktree 的未提交改动。
- `main` 原有未提交文件保持不动：`web/src/components/AppShell.tsx`、`docs/implementation-notes.md`、`docs/implementation-plan-63.html`、`docs/research/2026-08-26-scheduling-windows-minute-precision.md`、`web/src/prototypes/`。
- 本任务的实现记录维护在 `develop` worktree 的 `docs/implementation-notes.md`，不修改 `main` worktree 中同名未跟踪文件。
- Planner 只运行一次，输出 #81–#100 范围内全部 open `ready-for-agent` issue 的完整 DAG；控制者按拓扑序切分轮次，跨 issue 最多 4 个并行。

## Deviations

- AFK skill 默认规定仓库只有 `main` 时不新建 `develop`；本次按用户的明确指令创建 `develop`，原因是用户指定后续全部合并到 `develop` 并自行发起回 `main` 的 PR。基线严格取 `main` 的已提交 HEAD，未携带脏工作树内容。

## 实现进展

- 已创建并验证 worktree：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop`，当前分支 `develop`。
- 已验证 develop 基线为 `9bd651d`，工作树干净，`CONTEXT.md` 存在。
- 已验证原 `main` worktree 的未提交改动未被触碰。
- 下一步：运行 Planner，解析完整 DAG，并开始第一轮 unblocked issue 的 Implementer → Reviewer → Merger 流水线。

## 验证

- `git -C .../PostHub.develop status --short --branch`：`## develop`。
- `git -C .../PostHub.develop rev-parse HEAD`：`9bd651d864367ea1dd5119970f6e4346c4901b28`。
- 原 `main` 状态仍为既有脏工作树，未新增或丢失改动。

## 下一步

- Planner 扫描 issue #81–#100 的 `ready-for-agent` 开放项并构建 DAG。
- 每轮完成后更新本文件，记录依赖解锁、分支、测试、merge、issue 状态及任何 Deviations。

### Planner 结果（2026-08-27）

- 范围内 #81–#100 共 20 个 open `ready-for-agent` issue，均纳入 DAG；范围外无未关闭依赖。
- 首轮仅 #81 无阻塞；后续依赖链为：#81 → #82 →（#83、#84、#85、#87）→ #86/#88/#90 等，最终由 #100 gate 汇总验收。
- 判定类 ticket：#100（`kind: gate`）。
- 确定性分支：每个 issue 使用 `afk/issue-{N}`。

### Issue #81 Merger（2026-08-27）

- 合并前确认：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 已检出 `develop` 且工作树干净；`afk/issue-81` 指向 reviewer 提交 `2038b18`，对应 worktree 为 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-81`。
- 执行约束：仅在 develop 主 worktree 使用 `git merge afk/issue-81 --no-edit`；不 squash、不 push、不执行 GitHub 外部写操作；合并后跑 daemon、web、Tauri 全量验证，再清理该 issue worktree，最后在 develop 写 summarizing commit。
- 冲突处理：两侧均追加实现记录；保留 develop 的 Planner 记录、此 Merger 记录与 issue 分支的完整 #81 执行/审查记录，未改动业务代码意图。

## Issue #81：PostHub-owned 后端组合 seam

### 目标与计划

- 先盘点当前 daemon/backend 组合入口、官方路由、PostHub-owned 路由/数据库/生命周期模块及测试边界。
- TDD 垂直切片一：新增测试证明组合入口重复初始化幂等，且官方已有接口注册一次并保持可用。
- TDD 垂直切片二：实现独立组合入口，将 PostHub-owned 组件一次性注册到官方 Flask 应用，不复制或修改上游后端。
- TDD 垂直切片三：补齐官方账号、素材、单视频、旧批量 HTTP smoke 覆盖，并运行 Python/TypeScript/Cargo 全量测试。
- 同步修订 CONTEXT 与相关 ADR，明确受限本机 batch runner/history 是 PostHub-owned 扩展，不是通用 scheduler；保留不 fork 上游约束。

### Deviations

- 暂无。

### 实现进展

- 已定位本 worktree 与既有 `docs/implementation-notes.md`；后续记录追加在本节。
- Red：新增 `daemon/tests/test_composition.py`，先验证独立组合入口、重复初始化幂等、官方四类 HTTP seam 与官方数据库生命周期；初次运行因 `posthub.composition` 尚不存在而失败（`ModuleNotFoundError`）。
- Green：新增 `posthub.composition` 与 `posthub.routes`，将账号默认声明路由和发布声明适配移出 `sau_backend.py`；`run_backend.py` 改经组合入口启动；官方副本 SHA-256 恢复为记录值。
- Green 验证：`uv run pytest tests/test_composition.py -q` → `1 passed`；相关后端测试 → `24 passed`；daemon 全量 → `44 passed`。
- 文档：CONTEXT 与 ADR-0006 明确收窄旧绝对表述，并新增 ADR-0009 记录组合 seam 与受限本机 batch runner/history 边界。

### 最终验证记录

- `cd daemon && uv run pytest -q` → `44 passed`。
- `cd web && pnpm test -- --run` → `16 files / 171 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 均通过。测试过程仅有既有 jsdom navigation stderr，不影响通过结果。
- `cd src-tauri && cargo test --all-targets`：首次因仓库未生成 `src-tauri/resources/{daemon,bin,browser}` 目录而失败；补齐本地空资源目录后重跑 → `17 passed`（lib），`0 tests`（bin）通过。空目录未进入 git 状态。
- `daemon/sau_backend.py` SHA-256 → `6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d`。
- `cd daemon && uv run --with ruff ruff check ...` → `All checks passed`（仅检查本次涉及 Python 文件）。

### Deviations

- Tauri 测试前只补齐构建配置要求的本地空资源目录，未运行资源下载/打包流程；原因是本 issue 只改变后端组合层，避免把平台资源产物带入提交。Cargo 测试在该前置条件下通过。

### 审查发现（2026-08-27）

- 发现 P1：`_inject_declaration_to_xhs` 在安装 wrapper 后回调已替换的模块属性，会递归；且 wrapper 签名无默认值，官方 `/postVideoBatch` 的抖音调用少传尾参数会 500。
- 发现 P1：`_declaration_item` 产出平台字段扁平对象，但抖音 wrapper 按嵌套 `douyin` 键消费；视频号只 pop 后丢弃声明。
- 发现 P1：显式 `db_path` 只传给 PostHub 路由，官方 `sau_backend.BASE_DIR` 及上游发布模块仍指向导入时默认目录。
- 发现 P2：`routes.py` 的账号默认声明读取逻辑重复；需抽成单一 reader，并补充有效类型/带数据契约测试。
- 修复策略：wrapper 委托捕获的官方函数，不复制官方发布循环；用线程上下文向官方上传类代理注入声明；组合入口统一重定向官方模块的运行目录；扩展端点复用 reader，并用无网络 fake 验证单视频/批量与声明契约。
- 已修复：小红书 wrapper 改为委托捕获的官方函数；抖音 wrapper 补齐默认参数并修正 batch 尾参数；声明 payload 统一为平台嵌套形状；视频号接入明确 DOM seam，入口/选项不可用时显式失败；显式 db_path 同步到官方路由和上游发布模块；移除 routes 重复 JSON reader；官方副本 SHA-256 保持记录值。
- 修复后验证：`uv run pytest -q` → `44 passed`；涉及 Python 文件 `uv run --with ruff ruff check ...` → `All checks passed`；`pnpm test -- --run` → `16 files / 171 tests passed`；`pnpm run build` 通过；`cargo test --all-targets` → `17 passed`（lib）及 `0 tests`（bin）。
- 全量 `uv run --with ruff ruff check .` 仍报告仓库既有 `conf.py` 与官方 `sau_backend.py` 风格/未使用导入等问题；未按 lint 规则改动官方副本。

### Merger 执行记录（2026-08-27）

- 合并：首次执行因本轮笔记未提交而被 Git 保护性中止；暂存笔记后按要求重试 `git merge afk/issue-81 --no-edit`，唯一冲突为本文件。合并保留双方记录，继续合并生成 `3e03b8a`。
- daemon：`cd daemon && uv run pytest -q` → `44 passed in 13.30s`。
- web：`cd web && pnpm test` → `16 files passed / 171 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.70s`）。测试仅输出既有 jsdom navigation stderr。
- Tauri：首次 `cd src-tauri && cargo test --all-targets` 因 `resources/daemon` 不存在失败；仅创建本地空目录 `resources/{daemon,bin,browser}` 后重跑 → lib `17 passed`、bin `0 passed`。空目录未纳入 Git。
- Cargo.lock：Tauri 测试将既有 `Cargo.toml` 的 `posthub` 版本 `0.1.6` 同步写入 lock（原为 `0.1.4`）；保留该一致性修正，随本轮 summarizing commit 提交。

### Issue #81 R0 特殊已完成节点复核（2026-08-27）

- 复核目录：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop`；分支 `develop`；HEAD `18e708f`，工作树在测试前后均干净。
- 提交证据：HEAD 为 `chore: merger R9 完成 — 合并 #81`；其父提交含 `3e03b8a Merge branch 'afk/issue-81' into develop`，实现提交覆盖 `daemon/posthub/composition.py`、`daemon/posthub/routes.py`、`daemon/posthub/uploader_wrapper.py`、`daemon/run_backend.py`、`daemon/tests/test_composition.py` 等。
- `gh issue view 81 --json state,title`（关闭前）→ `OPEN`，标题为「建立 PostHub-owned 后端组合 seam 与领域边界」。
- `cd daemon && uv run pytest -q` → `44 passed in 2.25s`。
- 本次仅复核与验证；未 reset、rebase、merge 分支、push、建 PR 或修改业务代码；不创建 summarizing commit。
- 执行 `gh issue close 81 --comment '实现已在 develop 合入并完成 R0 复核；后续依赖节点可继续。'`；最终 `gh issue view 81 --json state,title` → `CLOSED`。

### Issue #82 Merger 准备记录（2026-08-27）

- 已按要求在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 检查 `develop` 状态与最近 8 条提交；当前仅有本文件的 #81 R0 复核笔记未提交。
- 为不丢失既有复核记录且满足 Git merge 的工作树保护，先将该纯中文 notes 改动单独提交；不修改业务逻辑、不触碰主仓库。
- 下一步：在该笔记提交后执行唯一允许的 `git merge afk/issue-82 --no-edit`；若 `docs/implementation-notes.md` 冲突，逐侧读取并保留 #81 与 #82 的全部有价值记录。

### 冲突解决记录（2026-08-27）

- `git merge afk/issue-82 --no-edit` 唯一冲突为本文件；原因是 develop 的 #81 R0/准备记录与 issue 82 分支的 #82 记录均从同一末尾追加。
- 已分别读取 ours 与 theirs，保留 #81 R0 复核、#82 合并准备及 #82 全部目标/实现/验证/审查记录；仅移除冲突标记，未改动业务实现。

## Issue #82：统一 EffectiveBatchItem normalization 与发布执行 adapter

### 目标与计划

- 先以现有官方 `/postVideo`、`/postVideoBatch` 请求结构和前端单视频/矩阵批量模型为事实来源，确定唯一 normalization + execution seam。
- TDD 先覆盖纯 normalization：平台/素材/账号/字段结构校验、账号拆分、账号快照、账号默认声明合并，以及 submitted/effective 双 payload。
- 再覆盖四平台 immediate/scheduled、封面、商品、草稿、分类字段 fixtures；确保无效输入在调用官方 HTTP/函数前失败。
- 将单视频与旧批量入口收敛到同一 adapter，adapter 只委托官方 HTTP seam，不复制官方发布循环、不引入自研 scheduler。
- 跑 daemon、web、Tauri 全量验证；按语义原子提交中文 commit，不 push、不建 PR、不关闭 issue。

### Deviations

- 暂无。

### 实现进展

- 已确认 issue 82 worktree `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-82`，基线为 issue 81 合并后的 `18e708f`，工作树初始干净。
- 已读取 `CONTEXT.md`、ADR-0001/0006/0009、`daemon/README.md` 及组合、声明、wrapper、官方请求和前端单视频/批量相邻测试。
- 现有事实：官方请求字段为 `fileList/accountList/type/title/tags/category/enableTimer/videosPerDay/dailyTimes/startDays/thumbnail/isDraft/productLink/productTitle`；账号默认声明目前仅在 daemon hook 合并，前端单视频与批量各自构造请求，尚无 EffectiveBatchItem 公共入口。
- 下一步：先新增单一公共 adapter 的失败测试，再按垂直切片实现。
- Red：新增 `daemon/tests/test_publish_adapter.py`，首轮 `cd daemon && uv run pytest tests/test_publish_adapter.py -q` 因 `posthub.publish_adapter` 尚不存在而在收集阶段失败（`ModuleNotFoundError`），确认测试先行。
- 原地重试先保留并审查全部 partial diff；初始 adapter + composition 定向测试为 `13 passed`，daemon 全量为 `56 passed`。
- Green：新增 `posthub.publish_adapter`，以官方请求体为输入，先整批结构校验，再按账号拆分，冻结官方 `user_info` 账号快照，按单账号合并默认声明与任务覆盖，产出原始 submitted 与账号粒度 effective payload。
- Green：官方 `/postVideo` 与 `/postVideoBatch` 的 before-request hook 共用 normalization；wrapper 按 source item 取出 effective 账号组，逐项委托捕获的官方平台函数，未复制上游文件/账号/定时循环；快手也接入同一 effective seam。
- Red→Green 补强：为不可 hash 的平台类型、浮点平台类型、声明/source 非字符串及 origin 非布尔新增 6 个失败用例；初次为 `6 failed, 12 passed`，最小类型守卫后为 `18 passed`，避免畸形 JSON 从 400 漏成 500。
- HTTP 运行态验证：在临时数据库和 fake uploader 下启动组合后端；单视频双账号产生 2 条账号粒度官方调用；完全相同 scheduled payload 经 `/postVideo` 与 `/postVideoBatch` 产生逐参数相同调用；非法平台、空素材、批次后项空账号均返回 400，官方调用总数保持 4，无新增发布副作用。

### 最终验证记录

- `cd daemon && uv run pytest -q` → `62 passed in 1.43s`。
- 相关 Python：`uv run --with ruff ruff check ...` → `All checks passed`；`ruff format --check ...` → `5 files already formatted`。
- `cd web && pnpm test -- --run` → `16 files / 171 tests passed`；仅有既有 jsdom navigation stderr。
- `cd web && pnpm run build` → `tsc --noEmit` 与 Vite build 通过，Vite `1.72s`。
- `cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 tests`。

### Deviations

- Cargo 测试继续只创建本地空 `src-tauri/resources/{daemon,bin,browser}` 目录以满足 Tauri 构建配置；目录为空且未进入 git，不引入打包资源产物。

### 收口复核（2026-08-27）

- 复核发现无关账号坏行会被全表 normalization 阻断；保守修补为按本次请求的 `(type, filePath)` 过滤账号，目标路径的畸形类型仍进入校验并返回明确错误，无关坏 `default_platform_fields` / `filePath` 行忽略。
- 新增回归：无关账号默认声明不是合法 JSON 时，目标账号仍能生成 effective item；相关定向测试 `20 passed`，ruff check/format 均通过。
- 实际全量复验：`cd daemon && uv run pytest -q` → `63 passed in 1.68s`；web `pnpm test -- --run` → `16 files / 171 tests passed`，`pnpm run build` 通过；Tauri `cargo test --all-targets` → lib `17 passed`、bin `0 passed`。

### 审查与精炼（2026-08-27）

- 审查目标：不 reset/rebase/amend implementer 提交 `ccbb1f7`，只在 issue 82 worktree 直接修补验收缺口；继续禁止修改官方源码、复制官方发布循环、跨请求复用状态。
- 复核重点：目标账号过滤与严格校验、submitted/effective 深拷贝隔离、单发/旧批量共用 normalization 与官方函数 seam、四平台字段保真、异常在发布副作用前返回。
- 初步检查发现：前置校验虽覆盖 normalization，但官方 route 仍各自读取并执行；需要把官方 `/postVideo` 与 `/postVideoBatch` 的实际调用统一收敛到 adapter seam，且确保官方 kwargs/参数位置（抖音封面/商品、视频号草稿）不被改写或丢失。
- 计划：先以当前官方包签名和 route 行为建立失败回归，再做最小职责调整；每个修改阶段补记录，并运行 daemon、相关 ruff、web、Tauri 全量验收后提交 `refine:`。
- 基线复验：`cd daemon && uv run pytest tests/test_publish_adapter.py tests/test_composition.py -q` → `20 passed`；当前未提交改动仅为测试导入与本笔记，均保留。
- 进一步核对官方签名：抖音函数仍要求 `thumbnail_path/productLink/productTitle` 尾参数，视频号草稿位于 `is_draft`；当前 wrapper 已有账号粒度调用映射，但路由仍直接解析原始请求，未把“规范化结果到官方命令”的职责显式收口到公共 adapter。
- Red（本轮）：新增三个边界回归，分别验证 dataclass 账号快照也必须重校验、发布请求中 effective 队列缺失时 wrapper 必须 fail-closed、`/postVideo` 非 object body 必须在官方函数前返回 400；运行定向测试得到 `3 failed, 19 passed`。
- Green（本轮）：统一复用 mapping 校验逻辑重验证 `AccountSnapshot` 值对象；发布请求开始先清空线程队列，单发畸形 envelope 交给 normalization，wrapper 在官方发布上下文缺 effective 时抛错而不直调；定向测试 `22 passed`。
- Runtime verify：临时启动组合 Flask 服务并通过 HTTP 驱动 `/postVideo`、`/postVideoBatch`；相同 scheduled/封面/商品/草稿 payload 均返回 200，fake official seam 各收到两条完全相同的账号粒度参数；`/postVideo` 数组畸形 body 返回 400（`item 必须是 object`），未产生 fake 调用。
- 跨包全量复验：`cd daemon && uv run pytest -q` → `65 passed in 1.65s`；`cd web && pnpm test -- --run` → `16 files / 171 tests passed`，`pnpm run build` 通过；`cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 passed`。
- Red（本轮审查）：新增回归锁定 XHS `source/origin` 与视频号 `origin` 不得在无可靠执行 seam 时静默丢弃，以及同一 Flask app 不得静默切换不同 `db_path`；定向测试得到 `5 failed, 22 passed`。
- Green（本轮审查）：normalization 对目标平台无可靠执行 seam 的声明字段 fail-closed（XHS `source/origin`、视频号 `origin`），默认字段的 `null` 不再进入 effective；组合入口同一 app 换用不同数据库路径直接拒绝；定向测试 `28 passed`，相关 ruff check/format 均通过。
- Deviations：未直接补写 XHS/Tencent UI 自动化 seam；当前上游无法可靠表达 XHS `source/origin`，且视频号上游会无视 `origin=False` 仍尝试原创。按保守策略拒绝这些字段，避免 HTTP 200 后静默错发。
- 本轮实际审查基线为 implementer 提交 `38fd430`；未 reset/rebase/amend，官方 `daemon/sau_backend.py` 与 `uploader/*` 未修改。
- Runtime verify：临时组合 Flask HTTP 服务接收混合平台 `/postVideoBatch` 返回 200；fake 官方 seam 实际收到抖音双账号两次独立调用，封面/商品参数完整；XHS 不支持声明返回 JSON 400；单发数组畸形 body 返回 JSON 400，均未产生对应 fake 调用。
- 修补后最终验证：`cd daemon && uv run pytest -q` → `71 passed in 1.70s`；相关 Python `ruff check` 与 `ruff format --check` → 全部通过；`cd web && pnpm test -- --run` → `16 files / 171 tests passed`，`pnpm run build` 通过；`cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 passed`。

### Issue #82 Merger 执行记录（2026-08-27）

- 合并前先将 develop worktree 中既有 #81 R0 复核 notes 单独提交为 `f5ed591 chore: 记录 #81 复核`；随后按唯一允许命令执行 `git merge afk/issue-82 --no-edit`。
- 合并唯一冲突为 `docs/implementation-notes.md`；已逐侧读取并保留 #81 R0/准备记录与 #82 全部实现、审查、偏离和验证记录，生成 merge commit `9ed2dd8`；未使用 `-X ours/theirs`，未修改业务代码。
- 合并后 daemon：`cd daemon && uv run pytest -q` → `71 passed in 2.23s`。
- 合并后 web：`cd web && pnpm test -- --run` → `16 files / 171 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.59s`）；测试仅输出既有 jsdom navigation stderr。
- 合并后 Tauri：`cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 passed`。
- 本轮未修改 `daemon/sau_backend.py`、官方 `uploader/*`、`web/` 或 `src-tauri/` 业务代码；未 push、未建 PR。
- 收尾：`wt remove afk/issue-82 -D --foreground` 已清理 issue 82 worktree 与本地分支；`gh issue close 82 --comment '实现已合并到 develop，完成 normalization / adapter 与 fail-closed 验收。'` 后 `gh issue view 82 --json state` 返回 `CLOSED`。

## Issue #83：定时契约 HH:MM 双读单写

### 目标与计划

- 仅处理定时契约：前端领域与官方请求的新写入统一使用 `string[]` HH:MM；迁移期读取旧 `number[]` 并在内存中规范化为 HH:MM。
- 先在 `web/src/domain/batch.test.ts`、`web/src/api/official.test.ts` 与相关 store 测试建立失败回归，再垂直实现纯时间函数、单视频/矩阵映射和 timer preference 迁移。
- 纯时间契约固定本地机器时间输入、最近整点四舍五入（正好 30 分钟向后）、跨午夜进位；不引入自研 scheduler/rules，不修改官方源码。
- 完成后运行 web 全量测试/build，并补 daemon/Tauri 全量测试（若环境允许）；提交中文语义原子 commit，不 push、不建 PR、不 merge、不关闭 issue。

### 已确认事实

- 当前 `TimerPref`、单视频表单和 `PostVideoRequest.dailyTimes` 仍为 `number[]`；`ScheduleView` 与单视频定时 UI 仍解析整数小时。
- 矩阵 `BatchItem` 已使用 `timeOfDay` HH:MM，但 `buildBatchItemsFromMatrix` 仍将时刻转为官方整点小时，且当前 parser 仅校验小时并丢弃分钟。
- 当前 worktree `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-83` 分支 `afk/issue-83`，基线为 `e3801de`，初始工作树干净。

### Deviations

- 暂无。

### 实现进展

- 已完成初始状态、现有定时 seam 与测试盘点；未修改业务代码。
- 已列出待锁定规则：HH:MM 严格解析与规范化、旧小时数组迁移、纯时间计算的本地时钟参数化、单视频与矩阵官方 payload 分别保持 HH:MM 字符串。
- Red：先新增 `web/src/domain/time.test.ts` 的 parser、双读单写、非法输入、机器本地时间、最近整点、30 分钟 tie-break、午夜 carry 测试；缺少 `time` 模块、后续缺少时间函数时按预期失败。
- Green：新增 `web/src/domain/time.ts`，以日内分钟作为纯计算值；`readTimeList` 双读旧小时/HH:MM，`writeTimeList` 与 `normalizeDailyTimes` 单写规范 HH:MM；`nearestWholeHour` 使用本地时分并在 30 分钟向后取整，显式返回 `dayCarry`，`carryStartDays` 合并起始日。
- Green：`PostVideoRequest.dailyTimes`、单视频 timer 输入与矩阵 effective payload 改为 `string[]`；矩阵映射保留 `timeOfDay` 分钟。旧 `parseHHMMToHour` 仅保留为兼容整点 seam 的最近整点降级。
- Green：`TimerPref`、发布表单、定时设置 UI 与矩阵时刻池统一 HH:MM；`loadTimerPref` 读取旧 number[] 后立即持久化 string[]，写入端规范化去重排序并拒绝非法矩阵时刻。相关定向测试 → `17 files / 189 tests passed`。
- Green：发现 daemon PostHub-owned normalization 原只接受旧整数数组，导致新前端请求无法通过官方 seam；在 `daemon/posthub/publish_adapter.py` 增加双读并将 effective payload 单写为规范 HH:MM，保留分钟。新增旧格式迁移、分钟保真、非法时间回归；daemon 定向测试 → `27 passed`。

### 最终验证记录

- `cd web && pnpm test -- --run` → `17 files / 189 tests passed`；保留既有 jsdom navigation stderr。
- `cd web && pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.89s`）。
- `cd daemon && uv run pytest -q` → `72 passed`；涉及 Python 文件 `ruff check` 与 `ruff format --check` 均通过。
- `cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 tests`；仅补齐本地空 `resources/{daemon,bin,browser}` 目录，未进入 Git。
- 未 push、未建 PR、未 merge、未关闭 issue；待提交中文语义原子 commit。

### Issue #83 Merger 执行记录（2026-08-27）

- 合并前确认：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 分支为 `develop`，工作树干净；仅执行 `git merge afk/issue-83 --no-edit`，未使用 squash、`-X`、push 或 PR。
- 合并结果：该分支基于当前 develop，按命令 fast-forward 至 `96bbd48`，无冲突；#83 的 HH:MM 领域契约、双读单写 normalization、前端 timer/domain/store/view/test 与文档记录均保留。
- 合并后 daemon：`cd daemon && uv run pytest -q` → `72 passed in 2.29s`；涉及 Python 文件 `ruff check` → `All checks passed`，`ruff format --check` → `2 files already formatted`。
- 合并后 web：`pnpm test -- --run` → `17 files / 189 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.03s`）；仅有既有 jsdom navigation stderr。
- 合并后 Tauri：`cargo test --all-targets` → lib `17 passed`、bin `0 passed`。
- 下一步：提交本次 Merger 笔记后，按顺序合并 #84；#83 worktree 与 issue 待全部本轮成功后依用户流程清理/关闭。
## Issue #84：扩展内容声明 context 为 canonical shape

### 目标与计划

- 仅修改 PostHub-owned 声明 wrapper/context seam，不触碰官方 `daemon/sau_backend.py` 或官方 `uploader/*`，不提前实现 #90/#91/#92。
- 先为 canonical producer `{platform, fields}`、canonical/legacy consumer 双读、item 级 context 的 finally 清理及连续 item 隔离补失败测试，再做最小实现。
- 保留外部 `platformFields` 按平台分键契约、英文枚举到官方中文文案映射，以及 normalization 的 fail-closed 边界。
- 完成后执行 daemon 全量 pytest、web 全量测试与 build，并记录实际输出；不 push、不建 PR、不 merge、不关闭 issue。

### 当前基线与调研结论

- issue 82 已将 `EffectiveBatchItem` 与执行 adapter 合入当前基线；当前 `_declaration_item_for_effective()` 仍产出平台名嵌套 shape，`_fields_for()` 尚不读取 canonical `fields`。
- 现有 `_declaration_context()` 已有 `try/finally` 的恢复语义，需补齐 canonical payload 与连续不同平台/声明的回归覆盖。
- 旧兼容形状包括 `{platform, <platform-name>: fields}` 与 `{platform, field...}`；canonical 只在内部 wrapper context 使用，外部 `platformFields` 不变。
- 无声明也采用 canonical shape `{"platform": type, "fields": {}}`；不扩展 origin、XHS source 等既有 fail-closed 执行边界。

### 实现进展

- 已完成只读调研：读取 `CONTEXT.md`、ADR-0008/0009、issue 计划、相关 prototype/research、声明映射、wrapper、normalization、composition 及现有测试；未修改官方源码。
- Red（producer 垂直切片）：新增 `test_declaration_producer_emits_canonical_platform_and_fields_shape`，`cd daemon && uv run pytest tests/test_publish_adapter.py -q` → `1 failed, 26 passed`；失败确认当前 producer 仍输出平台名嵌套 shape。
- Green（producer）：`_declaration_item_for_effective()` 改为始终产出 `{"platform": type, "fields": selected}`，无声明使用空 `fields`；同一批定向测试 → `27 passed`。
- Red（consumer 垂直切片）：新增 `test_declaration_consumer_reads_canonical_fields`，定向测试 → `1 failed, 27 passed`；失败确认 `_fields_for()` 尚未读取 canonical `fields`。
- Green（consumer）：`_fields_for()` 先读并校验 canonical `platform/fields`，再兼容旧平台嵌套与旧 flat shape；平台不匹配或 canonical fields 非 object 返回空字典；定向测试 → `28 passed`。
- Green（迁移 fixture）：新增旧平台嵌套与旧 flat shape 双读回归，定向测试 → `30 passed`。
- Green（空声明）：新增无任务/账号默认声明时的 canonical 空 `fields` 回归；首次误用带账号默认的 fixture 得到错误预期，改为显式清空该账号默认后重跑 → `34 passed`。
- Green（context 生命周期）：新增成功、异常、内建超时异常后的 finally 清理，以及随后不同平台声明可独立读取的回归；定向测试 → `34 passed`。
- Green（连续 item）：新增混合平台 effective item 执行隔离与首项超时后下一项独立读取回归；声明/组合定向测试 → `38 passed`，相关 ruff → `All checks passed`。
- 重构：更新迁移队列与组合测试注释，明确新 producer 只写 canonical shape，旧嵌套/flat 仅作兼容 fixture。
- Runtime verify：隔离启动组合 Flask 服务 `127.0.0.1:5419`，GET `/getAccounts` 返回 `200`；通过 HTTP POST `/postVideo` 驱动真实组合入口，返回 `200`，服务端 fake 官方 seam 观察到 active fields 为 `{'declaration': '无需添加自主声明'}`；验证服务已停止。

### 最终验证

- `cd daemon && uv run pytest -q` → `81 passed in 1.92s`。
- `cd daemon && uv run --with ruff ruff check posthub/uploader_wrapper.py tests/test_publish_adapter.py tests/test_composition.py` → `All checks passed!`。
- `cd web && pnpm test -- --run` → `16 files / 171 tests passed`；仅有既有 jsdom navigation stderr。
- `cd web && pnpm run build` → `tsc --noEmit` 与 Vite build 通过，Vite `2.07s`。
- `shasum -a 256 daemon/sau_backend.py` → `6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d`，官方文件未改；未修改官方 `uploader/*`，未修改 web 业务代码。
- `git diff --check` 通过；仅有本 issue 的 wrapper、测试与 implementation notes 变更，准备提交中文语义原子 commit。

### Deviations

- 暂无。

### Reviewer refinement（2026-08-27）

- 基线复核：`git diff develop...HEAD` 仅含 canonical producer/consumer、item context 回归与本笔记；官方 `daemon/sau_backend.py`、`uploader/*` 均未改，web 未改。
- 已复验基线：`cd daemon && uv run pytest -q` → `81 passed`；`cd web && pnpm test -- --run` → `16 files / 171 tests passed`；`cd web && pnpm run build` 通过。
- 发现验收缺口：`_fields_for()` 对匹配平台的 malformed canonical `fields`、旧平台嵌套容器及 flat 字段值会返回空字典或透传任意类型，可能静默丢声明或把非字符串交给 uploader。按保守策略改为只接受平台允许字段及其类型，畸形 context 显式失败；平台不匹配仍返回空字典，因为 `_active_fields()` 会跨平台探测。
- 同时补充同平台不同声明的连续 item 隔离，以及 canonical 与旧字段并存时 canonical 优先的回归；不扩展 #90/#91/#92，不引入新官方 seam。
- Green（review fix）：新增 `_validate_context_fields()`；canonical/旧平台嵌套的容器、字段名和值类型不合法时显式抛错，legacy flat 也不再把未知/错误类型字段静默透传；平台不匹配仍按跨平台探测语义返回空字典。
- Green（coverage）：canonical、旧平台嵌套与旧 flat 均补齐小红书/视频号/抖音三平台读取回归，并补 canonical 与 legacy 并存优先级；定向测试 `53 passed`，ruff check/format 均通过。
- 最终复验：`cd daemon && uv run pytest -q` → `96 passed in 1.58s`；`cd web && pnpm test -- --run` → `16 files / 171 tests passed`；`cd web && pnpm run build` 通过。
- Runtime verify：临时组合 Flask 服务经真实 HTTP `/postVideoBatch` 返回 `200`；fake 官方 seam 依次观察到抖音 `{'declaration': '无需添加自主声明'}` 与视频号 `{'declaration': '内容包含营销广告'}`，证明 canonical context 在跨平台 item 间隔离。畸形单发数组与错误声明类型均返回 `400`，没有调用 fake seam；服务已停止。

### Issue #84 Merger 执行记录（2026-08-27）

- 合并前确认：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 分支为 `develop`，工作树干净；按指定顺序仅执行 `git merge afk/issue-84 --no-edit`，未使用 squash、`-X`、push 或 PR。
- 冲突：`docs/implementation-notes.md` 单文件冲突；已保留 develop 侧完整 #83 HH:MM 实现/验证与 Merger 记录，并逐段追加 issue #84 分支的 canonical/legacy 双读、类型校验、finally 隔离回归及 Reviewer refinement 记录；未整体覆盖任一侧。
- 业务文件自动合并完成：保留 #84 的 canonical declaration validation/finally 隔离实现，同时保留 #83 的 HH:MM normalization 与测试变更；未做业务语义改写。
- 合并结果：生成 merge commit `f782083`，未修改官方 `daemon/sau_backend.py` 或 `uploader/*`。
- 合并后 daemon：`cd daemon && uv run pytest -q` → `97 passed in 1.47s`；涉及 Python 文件 `ruff check` → `All checks passed!`，`ruff format --check` → `3 files already formatted`。
- 合并后 web：`pnpm test -- --run` → `17 files / 189 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `0.90s`）；仅有既有 jsdom navigation stderr。
- 合并后 Tauri：`cargo test --all-targets` → lib `17 passed`、bin `0 passed`。
- 收尾：已执行 `wt remove afk/issue-83 -D --foreground` 并关闭/验证 #83 为 `CLOSED`；#84 worktree 与 issue 待本轮成功后按指定流程处理。

## Issue #87：修复整点 scheduled 发布链路

### 目标与计划

- 仅在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-87` 的 `afk/issue-87` 分支工作；不修改官方 `sau_backend.py` 或 `uploader/*`，不 push、建 PR、merge、关闭 issue。
- 先读取 `CONTEXT.md`、相关 ADR、#82 后的组合/adapter/wrapper 与现有 timer 测试，严格以预确认的 fake official uploader contract 建立红测试。
- 采用垂直 TDD 切片：四平台 scheduled 单视频/批量公共语义、`publish_strategy=scheduled`、`startDays` 关键字位置、抖音 batch 尾参数、XHS/快手 scheduled wrapper；再做最小重构并全量验证。
- 接受上游窗口边界与真实账号限制为已知 concern；不新增未经证据确认的平台时间窗口规则。

### Deviations

- 调研复核发现 XHS 仅按 basename 查找日期会让重复素材共享第一项日期；偏离最初的文件名映射计划，改用官方已知的“文件外层、账号内层”调用计数选取 index，保守覆盖重复文件名且仍不复制上游循环。

### 实现进展

- 已确认 issue-87 worktree 分支为 `afk/issue-87` 且初始工作树干净；已有笔记按项目约定继续追加在本文件。
- 已调用 TDD skill；已确认官方 `myUtils.postVideo` 四个入口都把 `start_days` 以第四个位置参数传给 `generate_schedule_time_next_day(..., timestamps=False, start_days=0)`，从而会把非零 `startDays` 错当成 `timestamps`；四个平台上传类均支持 `publish_strategy`，但四个官方入口未显式转发该策略，默认退回 immediate。
- 已确认官方 batch 抖音入口少传 `thumbnail_path`，造成 `productLink/productTitle` 尾参数左移；#82 wrapper 的 effective 路径已覆盖部分情形，但需用单发/批量同一 fake contract 锁定所有字段。
- 计划：新增四平台 fake uploader contract 测试，观察 wrapper 传给官方上传类的命名 `publish_strategy`、`start_days` 与平台专属参数；再以运行时类/时间生成适配最小修补，保留官方文件/账号遍历循环。
- Red：新增 `daemon/tests/test_scheduled_wrapper.py`，覆盖四平台 scheduled 类构造、`start_days=2` 不得生成 timestamps、抖音封面/商品尾参及单发/batch effective 命令一致；首轮结果 `5 failed`（XHS/快手缺原始类别名，抖音/视频号策略未注入，且测试契约暴露待修复的 timer 路径）。
- Green：在 `uploader_wrapper.py` 保存官方函数/生成器引用，运行时适配官方旧生成器为关键字 `start_days`，并给四个平台 uploader class 显式注入 `publish_strategy`（日期非 0 为 `scheduled`，立即路径为 `immediate`）；effective command 改为全关键字映射，抖音封面/商品尾参保持独立命名。
- Green：小红书新增薄 class wrapper，并以请求级文件/账号循环上下文把官方错误传入的完整 `publish_datetimes` 列表选择为当前文件日期；相同文件名也按外层文件 index 处理；未复制官方文件/账号遍历循环。
- Green：`publish_date=None` 保守映射为 immediate，避免无日期值被错误标记 scheduled。
- Green 测试：scheduled 定向契约扩至 HTTP 单发/batch 四平台、XHS 多文件/重复文件名、generator 关键字 seam，共 `16 passed`（关键三文件共 `44 passed`）；daemon 全量 `87 passed`。

### 验证

- `cd daemon && uv run pytest -q` → `87 passed`。
- 相关 Python `uv run --with ruff ruff check ...` 与 `ruff format --check ...` → 全部通过。
- Runtime verify：通过临时数据库启动真实组合 Flask socket（Werkzeug，随机本机端口），HTTP 驱动四平台 `/postVideo` 与 `/postVideoBatch`；fake uploader class 实际观察到 `publish_strategy=scheduled`、`startDays=1` 生成 `datetime`，抖音收到完整封面/商品尾参，视频号 category/isDraft 保持正确；8/8 请求 200。
- Runtime probe：同一 socket 对非法浮点 `startDays` 返回 JSON 400（明确指出 startDays），`/postVideoBatch` 非数组返回 JSON 400；均未进入 fake 发布。
- Web：`cd web && pnpm test -- --run` → 16 files / 171 tests passed（仅既有 jsdom navigation stderr）；`pnpm run build` → tsc 与 Vite build 通过。
- Tauri：补齐本地空 `src-tauri/resources/{daemon,bin,browser}` 目录后 `cargo test --all-targets` → lib 17 passed、bin 0 tests；空目录未进入 Git。

### Reviewer 复核（2026-08-27）

- 已按要求完整读取 `git diff develop..HEAD`；实现提交为 `7abe1bc`，未修改 `daemon/sau_backend.py` 或官方 `uploader/*`。
- 实测 `cd daemon && uv run pytest -q` → `87 passed in 1.67s`；scheduled 定向测试实际为 `16 passed`，修正上方误记的 `18 passed`。
- 相关 Python `ruff check` → `All checks passed`，`ruff format --check` → `6 files already formatted`；全量 lint/format 仍包含基线 `conf.py`、官方 `sau_backend.py` 等既有问题。
- 初步发现定时生成 wrapper 直接把 HH:MM 字符串交给上游仅支持整数小时的生成器，会在 scheduled 请求中抛 `TypeError`；本 issue 只修复现有整点契约，未复制官方时间生成或擅自丢分钟，改为对误落 `timestamps` 位置的非 boolean/int 值显式拒绝，避免静默当成 `startDays`。#83 的 HH:MM 平台精度适配仍需后续独立 seam。
- 精炼：XHS 日期列表不足素材数时不再复用末项日期，改为 fail-closed；补充相同文件名双账号 index、立即路径四平台显式 `immediate`、boolean `timestamps` 保真和错误类型边界测试。定向测试当前 `23 passed`。
- 复验：`cd daemon && uv run pytest -q` → `94 passed in 1.64s`；相关 3 个 Python 文件 `ruff check` → `All checks passed!`，`ruff format --check` → `3 files already formatted`。
- HH:MM 结论：当前 #87 官方整数小时契约不会把 HH:MM 误当 `startDays`；误落 `timestamps` 槽位的非 boolean/int 已显式拒绝。当前前端/daemon 仍由 #83 负责 HH:MM 双读单写与平台精度适配，本轮不复制官方时间生成。
- Runtime verify：在临时数据库、fake uploader 和 `127.0.0.1` Werkzeug socket 上实际发送四平台 `/postVideo` 与 `/postVideoBatch`，8/8 返回 200；服务端记录四个平台均为 `publish_strategy=scheduled`、`2026-08-30T10:00:00`，抖音三尾参完整、视频号 `category=7/is_draft=True`。数组 body、浮点 `startDays`、HH:MM（当前整数小时契约）分别返回 400，未进入 fake 发布。

### AFK 恢复收口（2026-08-27）

- 仅在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 的 `develop` 分支操作；开始时工作树干净，未触碰主仓库的用户改动。
- 已确认 `f782083`（#84 合并提交）是当前 develop 的祖先，HEAD 为其后验证提交 `7c71072`；#84 不重做实现或复审，仅恢复关闭。
- 已确认 #87 分支含实现提交 `7abe1bc` 与复核提交 `e620dac`；下一步按指定命令合并、完成全量验证、再清理与关闭。
- 已执行 `git merge afk/issue-87 --no-edit`，唯一冲突为本文件；逐侧保留 develop 的 #83/#84 历史和 #87 的完整记录，生成 merge commit `2484e15`，未使用 `-X`，业务文件自动合并。
- 合并后 daemon 全量 `uv run pytest -q` 失败：9 项 `test_scheduled_wrapper.py` 失败。#83 normalization 已将 `dailyTimes: [10]` 单写为 `['10:00']`，而 #87 的现有整点 scheduled generator 仍对字符串做整数运算，HTTP 单发/批量四平台返回 500（`unsupported operand type(s) for -: 'str' and 'int'`）。这是跨 #83/#87 的业务契约不兼容，不作实现、复审或修补；按用户要求立即停止，未运行后续 build、未清理 worktree/分支、未提交 recovery notes、未关闭 #84/#87。

### AFK Merger 本轮恢复执行（2026-08-27）

- 路径复核：目标 worktree 确认为 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop`，分支 `develop`，工作树干净；根仓库 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub` 的用户改动保持不动。
- #84 仅做拓扑核验：`d070a9f` 已是 `develop` 祖先，合并提交为既有 `f782083`，不重复 merge；本轮成功后清理并关闭 #84。
- #87 按用户指定改用修复后 tip `dda9a96`，包含 `3540e90`、`a280b50` 与边界测试；旧实现合并提交 `2484e15` 已在 develop，本轮必须合并新增提交。
- #85 tip `98273b7`，包含 accepted run 生命周期/恢复竞态修复 `efb80b7` 与 worker 回收、状态轮询边界测试；本轮必须合并。
- 执行顺序：先提交本准备记录以满足 Git merge 工作树保护，再逐分支拓扑 merge；每个实际 merge 后立即执行 daemon、web、build、Tauri 全量测试。只做最小冲突解决，不改无关业务；不 push、PR、squash、`-X`，不关闭父 issue #80。

### 回归修复记录（2026-08-27）

- 进入恢复时工作树干净；已知 develop 全量回归为 `tests/test_scheduled_wrapper.py` 9 项失败，根因是 #83 已将 `dailyTimes` 单写为 `HH:MM` 字符串，而当前 #87 generator 仍执行整数小时减法。
- 本轮严格 TDD：先运行现有 scheduled wrapper 测试确认回归，再补充 HH:MM 单视频/批量四平台 fake uploader contract 失败测试；保持旧 number[] 读取兼容，不退回字符串契约。
- Deviations：暂无。
- Red：新增 HH:MM generator 精度测试及四平台 HTTP 单发/batch 参数化契约后，`cd daemon && uv run pytest tests/test_scheduled_wrapper.py -q` 为 `5 failed, 23 passed`；generator 对 `"10:30"` 做整数减法触发 `TypeError`，HTTP 层则因 adapter 仍只接受整数返回 400。
- Green：adapter 双读旧整数/新 HH:MM，统一写出排序去重的 `HH:MM`；generator wrapper 仅在运行时把 HH:MM 转为带分钟的小数小时后关键字委托官方生成器，保留 `start_days` 与 `timestamps` 语义，不改官方源码、不复制发布循环。新增契约覆盖旧格式、新格式分钟保真及四平台 HTTP 单发/batch；定向测试 `56 passed`。
- Deviations：为兼容上游只支持整数减法的生成器，采用小数小时运行时适配而非重写官方生成算法；分钟由 `timedelta` 保真落到 `datetime`，避免静默取整。
- Runtime verify：临时数据库启动真实组合 Flask socket，HTTP 发送四平台 `/postVideo` 与 `/postVideoBatch`，8/8 返回 200；fake uploader 实际记录全部 `publish_strategy=scheduled`、`2026-08-29 10:30:00`，抖音封面/商品链接/商品标题与视频号 `category=7/is_draft=True` 均在正确参数位置；无 `TypeError`/`ValueError`/500。
- 顾问复核发现前端仍在 `official.ts` 将 HH:MM 截为整点，属于分钟丢失的 P1；按 TDD 先移植/补齐 #83 已确认的前端 HH:MM 回归测试，`cd web && pnpm test -- --run` 为 `11 failed, 164 passed`，失败集中于时间规范化、store 迁移、batch 校验与 API 请求格式。
- Green：补齐前端时间值对象、单视频/批量 API 与 store 的 HH:MM 双读单写，旧整数仅读取时转为 `HH:MM`；矩阵提交不再 floor 分钟。`cd web && pnpm test -- --run` → `17 files / 189 tests passed`；`pnpm run build` → tsc 与 Vite 均通过。daemon 复验 → `101 passed`。

### Issue #87 Merger 执行记录（2026-08-27）

- `git merge afk/issue-87 --no-edit` 发生两个冲突：`daemon/posthub/publish_adapter.py` 的 HH:MM 文档注释与 `docs/implementation-notes.md` 的并行记录；已逐侧读取，保留 #83 的单写 HH:MM 语义、#87 的分钟兼容实现/测试及双方历史，未使用 `-X`，未改无关业务。
- 合并提交：`2d25baf`（`Merge branch 'afk/issue-87' into develop`）；包含修复提交 `3540e90`、边界校验 `a280b50`、测试提交 `dda9a96` 的新增内容，旧实现合并 `2484e15` 已作为祖先保留。
- 合并后 daemon：`cd daemon && uv run pytest -q` → `140 passed in 2.21s`。
- 合并后 web：`cd web && pnpm test -- --run` → `17 files / 189 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.03s`）；仅有既有 jsdom navigation stderr。
- 合并后 Tauri：`cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 tests`。
- #87 Reviewer concern 保留：`PublishView` 尚无逐字 HH:MM 输入能力；不影响本轮合并，但需后续处理。

## Issue #85：贯通单 immediate item 的 accepted run 主干

### 目标与计划

- 仅实现单 immediate item 的 accepted-run 垂直主干：POST 立即返回 `runId`/accepted 语义，PostHub-owned SQLite 持久化 run/item，worker 通过测试注入执行器验证 `pending → running → success`，查询 API 作为事实来源，前端发布页刷新后恢复最近 run 状态；生产未配置真实 seam 时 fail-closed。
- 先以现有 #81/#82 组合入口与 `EffectiveBatchItem` 为 seam，建立 HTTP contract、数据库迁移、worker 生命周期、查询 API 与前端恢复的失败测试；每次只实现一个最小垂直切片。
- 不恢复 ADR-0001 的通用 scheduler/task/platform_job 模型；不修改官方发布执行真源，不引入 CDP、自研通用调度器或页面存活依赖。

### Deviations

- 暂无。

### 实现进展

- 已确认工作目录为 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-85`、分支 `afk/issue-85`；当前基线含 #81/#82 组合与适配实现，并继承 #87 合并后的已知 HH:MM 回归。后续只在本 worktree 工作。
- 已读取 `CONTEXT.md`、ADR-0006/0007/0009、组合入口、`publish_adapter.py`、`routes.py` 及既有测试；等待只读调研补充前端恢复与现有 prototype/测试落点。
- Red（HTTP / 持久化 / worker seam）：新增 `daemon/tests/test_runs.py`，首轮 `cd daemon && uv run pytest tests/test_runs.py -q` 在收集阶段失败：`posthub.composition` 尚无 `shutdown_posthub_backend`，确认生命周期 seam 需先建立。
- Green（后端第一切片）：新增 `posthub.runs`，独立 `posthub-runs.db` 的 runs/run_items schema、事务性 claim/finish、启动恢复、可停止 fake worker，以及 `/postRuns`（同时保留 `/posthub/runs` 兼容入口）accepted/detail/latest 查询；组合入口保存 run DB 路径并暴露 `shutdown_posthub_backend`。定向测试 → `4 passed`。
- Red（前端 API seam）：新增 `web/src/api/runs.test.ts`，全量启动命令中的该文件得到 `2 failed, 189 passed`；失败为 `officialApi.acceptRun/getRun` 尚不存在，确认前端需新增 accepted/query API。
- Green（前端 API/store）：`officialApi` 新增 `/postRuns` accepted/detail/latest 方法与显式 RunStatus 类型；新增 `stores/runs.ts`，仅持久化最近 `runId`，受理响应只置 pending，不写 success，刷新优先按指针查询并回退 latest。定向 API/store → `12 passed`（含既有 publish 测试迁移为 accepted 语义）。
- Green（发布页/顶部恢复）：立即模式单视频改走 accepted-run，反馈改为“已受理，后台执行中”；定时模式保留官方 `/postVideo`，避免扩大 issue 范围。AppShell 启动恢复最近 run 并按 daemon 轮询间隔刷新，顶部显示待执行/执行中/已完成真实状态与短 runId；状态映射测试 → `2 passed`。
- Green（worker 回归）：补充 fake uploader 收到持久化 effective payload、item 成功落库、worker 停止后重启将 running 复位并完成的测试；`cd daemon && uv run pytest tests/test_runs.py -q` → `6 passed`。

### 验证

- 尚未开始。

### 下一步

- 等待只读调研结果；随后先写第一条 accepted POST 失败测试并运行，记录实际 red 输出。

### Issue #85 复核与 TDD 修补（2026-08-27）

- 已读取当前工作树全部差异与新增文件；确认已有实现仍有三类验收缺口：默认 `FakeUploader` 空操作会假成功，worker stop/恢复没有 owner/lease 保护，前端异步查询可被旧响应覆盖且无 run 指针时不会重试 latest。
- 已读取 `CONTEXT.md`、ADR-0006/0007/0009 与 `src-tauri/src/lib.rs`：桌面窗口关闭由 ADR-0007 明确 kill 官方 daemon；“刷新/关闭发布页不影响后台”仅适用于页面生命周期，不能宣称桌面关闭后仍继续执行。
- Red（worker）：新增默认执行器 fail-closed、过期 lease 恢复、跨 `RunStore` owner 校验、阻塞 uploader stop 不重复恢复回归；并将 HTTP 默认 worker 断言改为明确失败。`cd daemon && uv run pytest tests/test_runs.py -q` → `5 failed, 6 passed`；失败分别暴露默认 Fake 成功、缺少 lease 参数与 owner 语义。
- Red（前端）：新增旧 `getRun`/`getLatestRun` 响应不可覆盖新 accepted run、无指针初次 latest 失败后 refresh 重试回归。`cd web && pnpm test -- --run src/stores/runs.test.ts` → `3 failed, 17 passed`（命令实际运行全部文件）；确认当前 store 的竞态与 latest 重试缺口。
- Green（后端）：`RunStore` 增加 `lease_owner/lease_until` 迁移列；claim 使用 owner token + SQLite `BEGIN IMMEDIATE`，recover 只回收过期 lease，finish 必须匹配 owner；`RunWorker.stop()` 超时保留仍存活线程引用，`start()` 不会重启/重复恢复，默认执行器改为明确抛错的 fail-closed uploader。定向测试 → `11 passed`。
- Green（前端）：`runs` store 以 mutation version + read sequence 丢弃旧 restore/refresh 响应；无内存/本地指针时 refresh 继续请求 latest，初始 daemon 不可用后可在轮询中恢复。定向命令实际运行全量 Vitest → `20 files / 199 tests passed`。
- 约束记录：`shutdown_posthub_backend` 文案明确只有页面刷新/关闭发布页不触发停止；桌面窗口关闭仍按 ADR-0007 kill daemon，不能宣称桌面关闭后继续执行。
- Green（初始化顺序）：`AppShell` 等待 `loadDaemonUrl()` 返回最终 URL 后再启动账号/探活/run 恢复，轮询仍读取当前 daemon URL，避免异步 URL 覆盖恢复请求。
- Deviations：全量 daemon 首轮复验暴露基线已有 #83/#87 的 HH:MM→旧官方整点 generator 不兼容（9 项失败）；为避免交付全量回归，追加 PostHub wrapper 边界适配：仅整点 `HH:00` 临时转旧整数，非整点明确拒绝，未修改官方 `sau_backend.py`/`uploader/*`，不恢复 scheduler。追加回归后 scheduled 定向测试 → `25 passed`。
- 已知未纳入本 issue：打包 daemon 的运行态数据库目录与 Tauri app_data 可写路径仍需独立生命周期/打包问题处理；本轮未改 `src-tauri`。
- 最终验证：`cd daemon && uv run pytest -q` → `133 passed in 3.44s`；相关 Python `ruff check` → `All checks passed!`，`ruff format --check` → `5 files already formatted`。
- 最终验证：`cd web && pnpm test -- --run` → `20 files / 199 tests passed`（保留既有 jsdom navigation stderr）；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过。
- Runtime verify：以临时 `POSTHUB_BASE_DIR` 启动真实 `uv run python run_backend.py`，HTTP `/getAccounts` 返回 200；合法 `/postRuns` 返回 200 + `runId`/`status=pending`，随后 `/postRuns/{runId}` 返回 `status=completed`、item `failed` 且错误为“未配置 immediate 发布执行器…”；数组 body 返回 JSON 400，未误报成功。服务已停止，临时数据已清理。
- `src-tauri` 本轮未修改，按条件未运行 cargo test；关闭窗口仍由现有 ADR-0007 进程树清理终止 daemon。
- 官方副本校验：`shasum -a 256 daemon/sau_backend.py` → `6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d`；未修改官方 `sau_backend.py` 或 `uploader/*`。
- 下一步：提交中文 commit 并确保工作树干净。

### Issue #85 协调复核补丁（2026-08-27）

- 复核发现三项遗漏：claim 后 stop 在 uploader 前直接返回会留下 running lease；`refresh()` 对 stale localStorage runId 的 404 只报错、不回退 latest；completed run 仍被 AppShell 每 5 秒轮询。
- Scope 修正：上一提交中为让全量测试通过而加入的 `uploader_wrapper.py` HH:MM 旧 generator 适配属于 #88，不纳入 #85；本轮撤回该两文件改动，保留 #85 accepted-run 修复。恢复后 #88 的既有 scheduled 回归按原状态保留，不在本轮修补。
- Red：先补 claim 后 stop 必须安全 requeue、stale pointer refresh 必须 fallback latest、completed 状态停止轮询及空异常仍为 failed 回归；定向测试分别暴露 lease 泄漏、latest 不回退与空字符串假成功。
- Green：新增 owner 校验的 `release_item`，stop 在进入 uploader 前释放自身 claim；`finish_item` 用 `error is not None` 判定失败；refresh 的 run 查询失败回退 latest 并清理空指针；AppShell 仅对未完成 run 轮询。
- 定向验证：`cd daemon && uv run pytest tests/test_runs.py -q` → `14 passed in 2.32s`；`cd web && pnpm test -- --run src/stores/runs.test.ts src/components/AppShell.test.ts` 实际全量运行 → `20 files / 201 tests passed`（既有 jsdom stderr）。
- 复核后全量：`cd daemon && uv run pytest -q` → `9 failed, 131 passed`，失败全部为已恢复的 #88 scheduled HH:MM 旧 generator 回归；本轮不修该问题。`pnpm test -- --run` → `20 files / 201 tests passed`；`pnpm run build` 通过；issue85 Python ruff check/format 通过。
- 已保留 `src-tauri` 不变；桌面窗口关闭继续按 ADR-0007 终止 daemon，页面刷新/关闭发布页不触发 worker 停止。

### AFK Merger 本轮收口（2026-08-27）

- 冲突解决：`docs/implementation-notes.md` 逐侧保留 #87 的合并/HH:MM generator 兼容/测试记录，以及 #85 accepted-run 设计、`98273b7`/`efb80b7`、生命周期与恢复修复、fail-closed/lease 修复和最终验证；仅删除冲突标记，未回退业务语义。
- 拓扑收口：#84 已由既有 `f782083` 合入 develop，本轮未重复 merge；#87 已由 `2d25baf` 合入并由 `274c9db` 验证；当前 #85 已完成 `git merge afk/issue-85 --no-edit`，生成 `46b585e`。
- #85 合并后 daemon：`cd daemon && uv run pytest -q` → `154 passed in 3.64s`。
- #85 合并后 web：`cd web && pnpm test -- --run` → `20 files / 201 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.13s`）；仅有既有 jsdom navigation stderr。
- #85 合并后 Tauri：`cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 tests`；仅补齐本地空 `resources/{daemon,bin,browser}` 目录，未进入 Git。
- 下一步：提交本轮中文 summarizing commit，随后验证并关闭 #84/#85/#87，清理三个 issue worktree；不关闭父 issue #80。

## AFK Merger：#86/#88/#90（2026-08-27）

### 准备与 stale #85 判断

- 目标 worktree `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.develop` 当前为 `develop` 且干净；根仓库 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub` 的未提交改动不触碰。
- 已核对分支 tip：`afk/issue-86=830b828`、`afk/issue-88=e1542c4`、`afk/issue-90=e9b9cff`、stale `afk/issue-85=1b574ea`。
- `git diff develop...afk/issue-85` 仅涉及 `daemon/posthub/uploader_wrapper.py`、`daemon/tests/test_scheduled_wrapper.py` 与本笔记；其业务差异是 HH:MM 转小数小时、分钟保真及边界测试，已被 #88 的 `021e4ac` 分钟级快照/兼容实现及后续提交覆盖；无独特且未丢失的业务改动。因此不合入 stale #85，待记录后用 `wt remove afk/issue-85 -D --foreground` 清理。
- 为满足 merge 前工作树保护，先提交本节准备记录；随后严格按 `86→88→90` 执行 `git merge <branch> --no-edit`，冲突逐侧读取解决，不使用 `-X`。

## Issue #86：支持多素材 immediate 提交与运行汇总

### 目标与计划

- 仅在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-86` 的 `afk/issue-86` 分支工作，基线为当前 `develop`；不 reset/rebase/amend，不 push、PR、merge、关闭 issue。
- 先以既有 FileView/BatchPublishSection、batch domain/store、`/postRuns` API/store、RunStore/worker 测试为事实来源，补齐素材多选交互、单次 accepted batch payload、后端真实 effective item 汇总与刷新恢复的失败测试。
- 最小实现：候选素材多选只存在发布区段本地 state；accepted run 扩展为 object/array payload 并统一走已有 normalization；RunSnapshot 由后端返回总数与成功/失败/进行中汇总，顶部只渲染后端事实；不引入 scheduled/retry/409。

### 调研结论

- `BatchPublishSection` 当前候选素材逐项按钮加入，`availableToAdd` 已按 `filePath` 去重；`FileView` 是纯素材管理页，不与 batch store 共享加入动作。
- `RunStore` 当前只返回 `items`，`/postRuns` 只接受 object，`accept_run` 使用单 item normalization；因此多素材 immediate 必须在已有 accepted-run route 上接受 object 或 array，并由 `normalize_publish_payloads` 展开账号粒度后一次 `create_run`。
- `BatchPublishStore.submit` 当前总是调用官方 `/postVideoBatch`，需要对全 immediate 矩阵改为一次 `acceptRun`；timer 路径保留现有官方 batch 语义，避免混入后续 issue。
- 原型 `docs/prototypes/posthub-app.html`、`docs/prototypes/posthub-app-variants.html` 及历史 `prototype/batch-multiselect-entry` 均指向复选框 + 全选条 + 计数 +「加入所选（N）」方案；加入后清空选择且不自动滚动/额外 toast。

## Issue #88：抖音分钟级 timer

### 目标与计划

- 在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-88` 的 `afk/issue-88` 分支实现抖音分钟级 timer；不修改官方 `daemon/sau_backend.py` 或 `uploader/*`，不混入 #89。
- 严格 TDD：先读取 #83/#87 后现有 timer、normalization、wrapper、run detail、fake uploader 与 HTTP 测试；以 `14:37`、本地日期、分钟边界、immediate/timer 混合建立失败回归，再逐垂直切片实现。
- 统一验证 preview、submitted/effective payload、fake uploader、run detail 的分钟保真；Python 仅用 `uv`，禁止 push/PR/merge/关闭 issue/reset/rebase/amend。


### Deviations

- 暂无。

### 执行计划

- 每个实际 merge 后立即运行 daemon `cd daemon && uv run pytest -q`、web `pnpm test -- --run` 与 `pnpm run build`、Tauri `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`；按实际结果追加记录。
- 全部合入且验证完成后，提交一条中文 summarizing commit；仅关闭 #86/#88/#90，父 #80 保持 OPEN；清理 #85/#86/#88/#90 worktrees，最终核验 issue、`wt list` 与 develop 工作树。

### 实现进展

- 已完成初始只读盘点并记录；下一步先新增 web/daemon 失败测试，确认多选、批量 accepted payload 与后端汇总缺口。
- Red：先新增 accepted `/postRuns` 数组 payload、批量 immediate 一次 run、多素材选择 helper、后端 summary 的回归；现有实现下 web 批量测试暴露仍按旧 `/postVideoBatch` 断言，daemon 新批量测试在 summary 缺失前先确认路由需支持数组。
- Green：`acceptRun` 支持单 object/非空数组；后端用统一 `normalize_publish_payloads` 展开实际 effective item 后持久化，并由 `run_items` 计算 `itemCount/pendingCount/runningCount/successCount/failedCount/completedCount`；批量 store 对全 immediate 一次调用 `/postRuns` 并记入既有 run store，timer/混合模式保留 `/postVideoBatch`。
- Green：批量候选素材改为复选框、全选/取消全选、已选计数和「加入所选（N）」；加入按候选稳定顺序写入、自动清空选择，`addItem` 按 filePath 幂等防重复，不引入 toast/滚动。
- Green：RunState 保存 accepted itemCount，查询快照保存后端 summary；AppShell 顶部进度显示 `完成 completedCount/itemCount`，不从浏览器 items 合成。
- 定向验证：daemon `tests/test_runs.py` → `15 passed`；web 定向命令实际运行全量 → `20 files / 205 tests passed`。
- 最终验证：`cd daemon && uv run pytest -q` → `155 passed`；`cd web && pnpm test -- --run` → `20 files / 206 tests passed`；`pnpm run build` → tsc 与 Vite build 通过；daemon changed files `ruff check` 与 `ruff format --check` 通过。
- Runtime verify：以临时 `POSTHUB_BASE_DIR` 启动真实 daemon；`GET /getAccounts` 返回 `code=200`，合法两 item 数组 `POST /postRuns` 返回 `200`、`itemCount=2`、同一 `runId`，随后查询返回 `summary.itemCount=2`、`completedCount=2`、两个 `failed`；空数组和缺失账号分别返回 JSON 400，未误报成功。进程已停止，临时数据已清理。
- Tauri：首次 cargo test 因本地打包占位目录 `src-tauri/resources/{daemon,bin,browser}` 缺失而失败；补建未跟踪空目录后 `cd src-tauri && cargo test --all-targets` → lib `17 passed`、bin `0 tests`，目录未进入 Git。
- 验证偏差：无业务偏离；Tauri 仅补本地空资源目录以满足现有构建脚本，不改变提交内容。

### Issue #86 Merger 执行记录（2026-08-27）

- 按要求执行 `git merge afk/issue-86 --no-edit`，业务文件自动合并；唯一冲突为 `docs/implementation-notes.md`。已逐侧读取并保留 develop 的 stale #85 判断/本轮计划与 #86 的完整目标、实现、验证记录，生成 merge commit `118c331`；未使用 `-X`，未回退 #85/#87 已合入能力。
- daemon：`cd daemon && uv run pytest -q` → `155 passed in 4.18s`。
- web：`pnpm test -- --run` → `20 files / 206 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `1.09s`）；仅有既有 jsdom navigation stderr。
- Tauri：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets` → lib `17 passed`、bin `0 tests`。
- #86 业务内容与验证均通过；下一步清理无独特业务改动的 stale #85，并合入 #88。

## Issue #88：抖音分钟级 timer

### 实现进展

- 已确认工作树与分支：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-88`、`afk/issue-88`；基线为 #85 收口后的 `3ec3663`，当前干净。
- 已读取 `CONTEXT.md` 与既有 implementation notes；已确认 #88 issue 要求：14:37 分钟保真、`startDays` + 本地日期生成 naive datetime、preview/submitted/effective/fake uploader/run detail 一致，以及分钟边界和混合 run。
- 现有缺口：effective 只有 HH:MM，没有持久化的绝对执行时刻；RunStore detail 不返回 submitted/effective；wrapper 仍在执行时临时生成日期，无法保证 run detail 与 fake uploader 共用同一时刻。决定新增 PostHub-owned `publishDatetimes`（naive ISO 字符串数组）到抖音 timer effective payload，运行时由 wrapper 使用同一快照注入官方 generator；submitted 保留原始 HH:MM。
- Red 计划：先补 Python normalization 日期快照、wrapper fake uploader、RunStore detail/混合 immediate-timer 回归；再补前端 preview/批量 payload 的分钟保真回归。实现只在 PostHub wrapper/adapter/run detail 与 web seam，绝不改官方源码。
- Red 已确认：新增的 normalization 回归因缺少 `now` 参数失败；现有 `publish_adapter.py` 草稿仅有未接线的日期 helper，且其正则转义待修。继续补齐 wrapper 与 detail 的失败断言，再实现。
- Red 扩展：补充 fake uploader 必须复用 normalization 绝对时刻、RunStore detail 必须同时返回 submitted/effective 的断言；并补充前端 preview 对 timer HH:MM 规范化的回归。
- Green 实现：normalization 接受可选冻结 `now`，仅抖音 timer 生成 `publishDatetimes`（本地日期 + `startDays` + 次日语义，naive ISO 秒精度）；wrapper 用 thread-local 将该快照注入官方 generator，仍不改官方源码；RunStore detail 返回持久化 submitted/effective，web 类型兼容旧响应，preview 与 payload 共用 HH:MM 规范化。
- 验证完成：`cd daemon && uv run pytest -q` → `159 passed`；`cd web && pnpm test -- --run` → `20 files / 202 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过；涉及 Python 文件 `uv run --with ruff ruff check` 与 `ruff format --check` 均通过。web 测试仅有既有 jsdom navigation stderr。
- Runtime verify：启动真实组合 Flask socket `127.0.0.1:5428`，HTTP `/postVideo` 与 `/postVideoBatch` 均返回 `200`；fake 抖音 uploader 两次收到同一 `2026-08-29T14:37:00` naive datetime 与 `scheduled` 策略；数组 body 探针返回 JSON `400`，未进入发布 seam。服务已停止并清理临时数据。
- Deviations：为让 detail 与 fake uploader 共享同一冻结时刻，新增 PostHub-owned `publishDatetimes` 到抖音 timer effective（submitted 仍保留原始 HH:MM）；这是必要的执行快照，不修改官方代码，也不承担新的 scheduler。
- Reviewer 修复：`now=None` 时同一批多个 effective item 曾逐项读取本地时钟，跨午夜可能得到不同日期；现于首次抖音 timer item 冻结一次本地 naive 时钟，并补多账号跨午夜回归。

### Issue #88 Merger 执行记录（2026-08-27）

- 按要求执行 `git merge afk/issue-88 --no-edit`，业务文件自动合并；唯一冲突为 `docs/implementation-notes.md`。已逐侧读取并保留 #86 的多素材 immediate 记录与 #88 `021e4ac`、`4c878b4`、`e1542c4` 的分钟快照、本地 naive 时钟及跨午夜修复记录，生成 merge commit `6af1154`；未使用 `-X`，未回退 #85/#87/#86 能力。
- daemon：`cd daemon && uv run pytest -q` → `161 passed in 4.12s`。
- web：`pnpm test -- --run` → `20 files / 207 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `0.91s`）；仅有既有 jsdom navigation stderr。
- Tauri：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets` → lib `17 passed`、bin `0 tests`。
- #88 业务内容与验证均通过；下一步合入 #90 声明三态改动。

## Issue #90：贯通抖音内容声明三态

### 目标与计划

- 仅在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-90` 的 `afk/issue-90` 分支实现；不修改官方 `daemon/sau_backend.py` 或 `uploader/*`，不 push、PR、merge、关闭 issue、reset、rebase、amend。
- 以既有 #84 canonical declaration context、#85 accepted-run 与 #87 wrapper 为边界，先补三态/快照/详情/预览/构造器回归，再逐个垂直切片实现。
- 三态语义固定为：任务空字段不覆盖账号默认；`no_need` 明确覆盖默认；其它合法抖音英文枚举保存英文值并由 wrapper 映射中文文案。首次受理时将 effective 快照写入 run item，后续账号默认变更不得影响详情或执行。

### 预确认 seams

- `normalize_publish_payloads`：任务覆盖与账号默认合并的唯一 effective producer。
- `_declaration_context` 与抖音 uploader class wrapper：构造器读取当前 item 的中文文案，成功/异常 finally 恢复线程上下文。
- `RunStore.get_run` / `/postRuns/{runId}`：返回持久化 effective item 详情；前端 `BatchPreviewDialog` 与运行状态区消费该详情。

### 实现进展

- 已读取 `CONTEXT.md`、ADR-0008/0009、#84/#85/#87 实现与测试、抖音声明映射、批量预览、run store/API/store；确认 normalization 已具备三态合并基础，但 run detail 丢弃 effective，preview 不显示最终有效声明，且尚无 fake constructor 文案回归。
- 已保留前置代理留下的未提交 TDD 改动：新增三态 normalization、fake DouYin constructor、run detail 快照与前端 preview/domain 回归；当前继续在同一 worktree 收口，不等待外部调研。
- 定向验证：daemon `tests/test_publish_adapter.py tests/test_runs.py` → `73 passed`；web 声明/预览定向文件随 Vitest 实际全量配置运行 → `20 files / 204 tests passed`。
- 全量验证：daemon → `159 passed`；web → `20 files / 204 tests passed`；`pnpm run build` 通过。
- Tauri 首次 `cargo test --all-targets` 因仓库忽略的 `src-tauri/resources/daemon` 不存在而失败；按既有项目验证约定补齐本地空 `resources/{daemon,bin,browser}` 目录后重跑通过（lib `17 passed`，bin `0 tests`），空目录未纳入 Git。
- Runtime verify：临时 `POSTHUB_BASE_DIR` 启动真实 `uv run python run_backend.py`，HTTP `/postRuns` 三次受理（空字段继承 `marketing`、显式 `no_need`、具体 `fictional`）均返回 200；详情 effective 分别保留英文枚举。受理后将账号默认改为 `ai_generated`，首个 run detail 仍为 `marketing`；worker 未注入生产执行器，按 fail-closed 记录为 failed，未触碰真实平台。
- lint：相关 Python `ruff check` 通过；`ruff format --check` 通过；官方 `daemon/sau_backend.py` SHA-256 保持 `6f2f49180cf24f17003ab7f50be5b098d472e735f765ec607e334becf41fc61d`。
- 最终验证：daemon `uv run pytest -q` → `159 passed`；web `pnpm test -- --run` → `20 files / 204 tests passed`；`pnpm run build` 通过；Tauri `cargo test --all-targets` → lib `17 passed`、bin `0 tests`。
- 下一步：提交中文语义原子 commit。

### Deviations

- Tauri 首次测试因仓库忽略的资源目录缺失失败；仅补齐本地空 `resources/{daemon,bin,browser}` 后通过，空目录未纳入 Git。
- web 测试保留既有 jsdom `navigation (except hash changes)` stderr，不影响通过。

### AFK Reviewer 复核（2026-08-27）

- 复核 `6d9f79f^...6d9f79f`：变更仅涉及 `runs.py` 快照返回、声明三态/预览/run detail、类型和回归测试；未改官方 `daemon/sau_backend.py`、`uploader/*`，未引入 retry、scheduler 或新的 platform wrapper。
- Issue #90 五项验收逐项核对通过：空/default、显式 `no_need`、具体枚举的 effective 区分；首次受理快照冻结；fake DouYin 构造器中文映射；成功/异常/超时 finally 清理；preview/run detail 展示。
- 兼容性核对：保留官方 HTTP seam、`platformFields.douyin`、HH:MM 双读单写和独立 run DB；`runs.py` 仅增加读取已持久化 `effective_json`，未改 accepted-run 公共状态机。与 #86/#88 的重叠点已确认不引入其数组/summary 或分钟快照语义。
- 复核验证：daemon `cd daemon && uv run pytest -q` → `159 passed`；web `pnpm test -- --run` → `20 files / 204 tests passed`；`pnpm run build` 通过；Tauri `cargo test --all-targets` → lib `17 passed`、bin `0 tests`；相关 Python `ruff check` / `ruff format --check` 通过。
- 未发现需修复的业务缺陷；本轮不改业务代码。工作树最终须保持干净。

### Issue #90 Merger 执行记录（2026-08-27）

- 按要求执行 `git merge afk/issue-90 --no-edit`，冲突涉及 `runs.py`、daemon 测试、official API、BatchPreviewDialog 与本笔记；已逐侧读取并手工整合，保留 #88 的 `publishDatetimes` 分钟快照/跨午夜实现及 #90 声明三态、preview 和快照类型改动，生成 merge commit `f3d4272`。未使用 `-X`，未回退 #86/#88 能力。
- 冲突取舍：RunStore 与前端 RunItem 同时保留 submitted/effective；预览函数同时保留 HH:MM 规范化与抖音最终声明展示；测试同时保留分钟快照跨午夜回归与声明三态回归。
- daemon：`cd daemon && uv run pytest -q` → `166 passed in 4.03s`。
- web：`pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过（Vite `0.95s`）；仅有既有 jsdom navigation stderr。
- Tauri：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets` → lib `17 passed`、bin `0 tests`。
- 本轮未发现新的业务 concern；仅保留既有 jsdom navigation stderr。下一步提交本轮中文 summarizing commit，关闭 #86/#88/#90 并清理对应 worktrees。

## Issue #91：贯通视频号内容声明 DOM wrapper

### 目标与计划

- 仅在 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-91` 的 `afk/issue-91` 分支实现；基线为 `develop`，不 push、PR、merge、关闭 issue、reset、rebase、amend。
- 先读取 #90 声明 context、`uploader_wrapper`、`runs`、现有 wrapper/fixture/详情/测试，确认视频号官方 DOM 入口和 PostHub-owned seam；不修改或 fork 官方 uploader。
- 严格 TDD：先锁定视频号 `no_label`、`ai_generated` stub page 成功路径、双 selector 任一命中、入口未渲染/候选缺失/双 selector 未命中显式 warning/fail-closed、warning/debug screenshot 可查询、item 隔离及真实账号 selector/最终显示值记录。
- 保持 `platform_fields.wechat` 分键，不混入 XHS/retry；优先复用现有 run/item 日志与详情查询 seam，确保 DOM 异常 finally 清理。

### Deviations

- 暂无。

### 实现进展

- 已确认目标 worktree 分支为 `afk/issue-91`，HEAD 与 `develop` 同为 `8b65a6b`，初始工作树干净；已有项目约定 implementation notes 位于 `docs/implementation-notes.md`，本节追加维护。
- 已完成前置调研派发，等待只读结果；下一步读取相关源码和 fixture 后，先新增失败测试并记录实际 Red 输出。

### 验证

- 尚未开始。

### 下一步

- 建立视频号 DOM wrapper 的最小 fake page/账号日志测试，先验证 no_label 与 ai_generated stub 成功路径及所有 fail-closed warning/detail 约束。
- Red：新增 stub page 的 6 个视频号 DOM/诊断测试；首轮因 pytest 环境无 async 插件失败，改为项目现有同步 pytest 约定后，继续暴露 helper 无 account/debug/diagnostics seam。
- Green（DOM seam）：`uploader_wrapper.py` 增加「内容声明」/「添加声明」双入口 selector fallback，支持 `no_label → 无需标注` 与 `ai_generated → 含AI生成内容`，候选/入口未渲染/双 selector 未命中/点击异常均 warning + debug screenshot + 显式抛错；成功诊断记录真实账号、命中 selector、最终显示值。
- Green（item 诊断）：`RunStore.run_items` 增加迁移安全的 `diagnostics_json`，`get_run()` 返回 item diagnostics；`RunWorker` 在每个 item 前清理 wrapper 诊断、执行后持久化 warning/debug 信息，避免跨 item 泄漏。视频号定向与 runs 相关测试 → `69 passed`。
- 最终验证：`cd daemon && uv run pytest -q` → `174 passed`；相关 Python `ruff check` → `All checks passed`，`ruff format --check` → `4 files already formatted`。
- 最终验证：`cd web && pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过。
- 最终验证：Tauri 首次因忽略的 `src-tauri/resources/{daemon,bin,browser}` 缺失失败；补齐本地空目录后 `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` → lib `17 passed`、bin `0 tests`，空目录未纳入 Git。
- API 契约：`web/src/api/official.ts` 增加可选 `RunItemDiagnostic` 类型，兼容旧 daemon；详情 payload 的 `diagnostics` 包含 warning、selector、账号、最终显示值和 screenshot 路径。
- 官方源码边界：未修改 `daemon/sau_backend.py` 或官方 `uploader/*`；未混入 XHS/retry；未 push、PR、merge、关闭 issue、reset、rebase、amend。

## AFK Reviewer 复核：f152fc3

### 复核发现与修复

- Red：新增同一 item 内连续处理两个视频号账号的诊断累积测试；原 helper 每次调用都会清空 thread-local，导致前一个账号的 selector/最终显示值丢失。
- Green：将诊断清理边界收敛到 RunWorker 的 item 起止；移除 DOM helper 内的清理，并在官方 HTTP 发布请求 before/teardown 清理，避免跨 item/请求泄漏，同时保留同一 item 多账号诊断。
- 补齐入口点击失败与候选点击失败的 warning、debug screenshot、fail-closed 测试覆盖。

### Deviations

- 与实现提交原计划不同：helper 不再承担每次 DOM 调用的清理职责，因为一个 effective item 可包含多个账号；采用 item/request 生命周期边界，避免丢诊断。

### 验证

- 定向视频号测试：`9 passed`。
- 提交前继续运行 daemon 全量、web test/build；Tauri 仅在本轮改动触及相关桌面代码时运行。
- 复核后 daemon 全量：`uv run pytest -q` → `177 passed`；定向 Python ruff check/format check → 通过。
- 复核后 web：`pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → tsc 与 Vite build 通过；仅有既有 jsdom navigation stderr。
- 运行实例：隔离 `POSTHUB_BASE_DIR` 启动 `run_backend.py`，`GET /getAccounts` 返回 200；空 `/postRuns` 返回 400；隔离账号 accepted run 进入 completed/failed，RunStore detail 返回 `diagnostics: []` 与 fail-closed error。真实浏览器发布未驱动，避免无 dry-run 的外部发布副作用。
- Tauri：本轮未改 `src-tauri`，按改动范围跳过。

### AFK Implementer 收口（2026-08-28）

- 继续审计 `f152fc3` 与其未提交改动；未 reset、stash、覆盖或 amend，当前仅保留 #91 的 wrapper、路由、测试和本笔记差异。
- 复验定向测试：`cd daemon && uv run pytest tests/test_wechat_declaration.py tests/test_runs.py -q` → `28 passed`。
- 复验后端全量：`cd daemon && uv run pytest -q` → `177 passed in 5.23s`；相关 Python `ruff check` → `All checks passed`，`ruff format --check` → `5 files already formatted`；`git diff --check` 通过。
- 复验前端全量：`cd web && pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过。仅有既有 jsdom navigation stderr。
- 真实账号验收 concern：本轮未驱动真实账号，不能宣称平台最终显示值已实测；当前代码记录的候选 selector 为 `text="内容声明"` / `text="添加声明"`，成功诊断记录实际命中的 selector、账号和候选 `inner_text()`，待真实页面验收时逐项回填最终显示值。
- Tauri：本轮未改 `src-tauri`，按改动范围跳过；未 push、未建 PR、未 merge、未关闭 issue。

### AFK Implementer 继续收口（2026-08-28）

- 状态复核：当前 worktree 为 `/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub.afk-issue-91`、分支 `afk/issue-91`，HEAD `7c23b88`；只保留未提交的 `daemon/tests/test_wechat_declaration.py` 红测试，未 reset、stash、覆盖或 amend 既有 commit。
- 复验既有 Red：`cd daemon && uv run pytest tests/test_wechat_declaration.py -q` → `3 failed, 9 passed`；失败为点击后空展示值、最终文案读取异常、展示值不匹配仍被请求值 fallback 伪装成功。
- 收口门槛：selector fallback 只允许明确可恢复的 Playwright locator probe 异常；entry 必须区分 selector unmatched、present-hidden、probe failed；点击后必须由 DOM 真实展示值验证；RunStore diagnostics 写入/lease/cleanup 失败不得打断 worker 终态；claim/recover/retry 清空旧 diagnostics；发布详情展示 warning 与 screenshot 路径。
- 下一步：先补上述边界失败测试，再做最小 wrapper/RunWorker/RunStore/UI 实现；保留官方源码边界与真实账号验收 concern。
- 补充 Red：selector 编程异常不得被 fallback 吞掉、明确 Playwright timeout 可继续尝试第二 selector、present-hidden 与 selector unmatched 分流、候选 probe 编程异常显式诊断；RunWorker 诊断写入返回 False/抛 DB 异常时 item 必须 failed，claim/recover 重试清空旧 diagnostics，finish lease 丢失只告警且不打断 worker cleanup。
- Green（DOM）：selector fallback 仅捕获 `PlaywrightTimeoutError` 作为可恢复 probe 异常；generic DOM/程序异常记录 `entry_probe_failed`/`option_probe_failed`、账号、selector、reason、screenshot 后原因抛出；入口诊断区分 `entry_selectors_unmatched`、`entry_present_hidden`、`entry_probe_failed`。
- Green（事实校验）：点击候选后只读取真实 DOM `inner_text()`；读取异常、空值、与请求值不一致均 warning + screenshot + fail-closed，不再以请求值伪造 `displayValue`。
- Green（worker/store）：recover、claim、release 清空旧 diagnostics；诊断持久化返回 False/抛异常转 item failed；finish 返回 False 或抛异常记录 run/item/lease 告警，heartbeat 的 `finished` 仍在 finally 执行。
- Green（web）：最近运行详情新增可访问的诊断列表，展示 warning/info、账号、selector、请求值、展示值与 debug screenshot 路径。
- 定向验证：`cd daemon && uv run pytest tests/test_runs.py tests/test_wechat_declaration.py -q` → `40 passed`；相关 Ruff check 通过、format check 通过。
- Web 验证：`cd web && pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过；保留既有 jsdom navigation stderr。
- Deviations：为避免真实浏览器断连/程序 bug 被伪装为 selector 未命中，仅把明确 `PlaywrightTimeoutError` 视为可恢复 probe；其余异常立即 fail-closed。真实账号与 Windows 进程树仍未驱动，保留 concern。
- Runtime verify：通过临时 Flask/Werkzeug 本机 socket 发送真实 HTTP `/postRuns`；注入安全 fake page 使视频号 `no_label` 候选缺失，受理返回 `200/status=pending`，查询返回 `completed`、item `failed`、`reason=option_unavailable`、`account=wechat.json`、`selector=text="内容声明"`，debug screenshot 文件存在；日志实际包含 account/reason/selector/screenshot。未驱动真实账号或外部发布。
- 兼容性补强：实测发现官方发布链路使用 `patchright`，其 `TimeoutError` 与 `playwright.TimeoutError` 非同一类；wrapper 现将两者都限定为可恢复 locator probe 异常，并补充双类回归，避免真实页面 timeout 被误报为程序故障或吞掉。
- 最终验证：`cd daemon && uv run pytest -q` → `190 passed in 4.45s`；定向 wrapper/runs → `41 passed`；相关 Ruff check/format check 与 `git diff --check` 通过。web 已验证 `pnpm test -- --run` → `20 files / 210 tests passed`，`pnpm run build` → tsc/Vite 通过。
- 真实账号 selector/最终显示值与 Windows 进程树仍无法在当前 macOS 环境验证；不伪装通过。未 push、PR、merge、关闭 issue。

### AFK Implementer 最终边界收口（2026-08-28）

- Red：补充候选缺失与候选 present-hidden 诊断契约；原实现把候选缺失错误记录为入口 selector，并把 present-hidden 与 unmatched 合并。
- Green：候选诊断分别记录 `get_by_text(text=..., exact=True)` / `text=...` 真实探测 selector；候选存在但不可见使用 `option_present_hidden`，候选均未命中保留 `option_unavailable`；候选点击/最终展示值失败记录候选 selector 与入口 `entrySelector`。
- Green（lease）：heartbeat 首次循环立即续租，缩短探测间隔，并对续租异常/lease 丢失明确记录 run/item 日志，降低短 lease 调度抖动造成重复领取的窗口。
- 定向回归：`cd daemon && uv run pytest tests/test_wechat_declaration.py tests/test_runs.py -q` → `42 passed`；daemon 全量 → `191 passed in 6.05s`。
- Web 回归：`cd web && pnpm test -- --run` → `20 files / 210 tests passed`；`pnpm run build` → `tsc --noEmit` 与 Vite build 通过；保留既有 jsdom navigation stderr。
- 运行验证：启动隔离临时数据目录的 Flask HTTP 服务，通过真实 `POST /postRuns` 提交视频号 `no_label`，安全 fake page 让入口命中、候选缺失；查询 `GET /postRuns/<runId>` 得 `status=completed`、item `failed`、`reason=option_unavailable`、账号 `wechat.json`、两个候选 selector 与可访问 screenshot 路径。另以 `{}` 探测返回 400，GET `/postRuns` 返回 405。
- 一次性验证启动修正：组合入口的 `uploader` 不是公开参数，验证服务改为组合后替换已注册 worker 的安全 fake uploader；未修改生产组合 API。
- 真实账号 selector/最终展示值与 Windows 进程树仍无法在当前 macOS 验证；不伪装通过。未 push、未建 PR、未 merge、未关闭 issue。

