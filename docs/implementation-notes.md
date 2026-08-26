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
