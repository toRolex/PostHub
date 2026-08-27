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
