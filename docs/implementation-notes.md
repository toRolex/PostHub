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
- Green 测试：scheduled 定向契约扩至 HTTP 单发/batch 四平台、XHS 多文件/重复文件名、generator 关键字 seam，共 `18 passed`（关键三文件共 `44 passed`）；daemon 全量 `87 passed`。

### 验证

- `cd daemon && uv run pytest -q` → `87 passed`。
- 相关 Python `uv run --with ruff ruff check ...` 与 `ruff format --check ...` → 全部通过。
- Runtime verify：通过临时数据库启动真实组合 Flask socket（Werkzeug，随机本机端口），HTTP 驱动四平台 `/postVideo` 与 `/postVideoBatch`；fake uploader class 实际观察到 `publish_strategy=scheduled`、`startDays=1` 生成 `datetime`，抖音收到完整封面/商品尾参，视频号 category/isDraft 保持正确；8/8 请求 200。
- Runtime probe：同一 socket 对非法浮点 `startDays` 返回 JSON 400（明确指出 startDays），`/postVideoBatch` 非数组返回 JSON 400；均未进入 fake 发布。
- Web：`cd web && pnpm test -- --run` → 16 files / 171 tests passed（仅既有 jsdom navigation stderr）；`pnpm run build` → tsc 与 Vite build 通过。
- Tauri：补齐本地空 `src-tauri/resources/{daemon,bin,browser}` 目录后 `cargo test --all-targets` → lib 17 passed、bin 0 tests；空目录未进入 Git。
