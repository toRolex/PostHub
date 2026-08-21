# Handoff: PostHub issue #43 平台内容声明按平台分键透传

## 现状

实现已落地并 commit 到 main 分支（`61dc974`）。

- 工作分支：`main`
- 工作目录：`/Users/rolex/Documents/Codes/githubProject/MyProject/PostHub`
- GitHub Issue：<https://github.com/toRolex/PostHub/issues/43>
- 提交：`61dc974 feat: 平台内容声明按平台分键透传（issue #43 / ADR-0008）`
- PR：未创建（用户未要求；如需开启 PR，建议 `/implement` 续跑或手动 `gh pr create`）

测试状态：

| 套件 | 命令 | 结果 |
|---|---|---|
| daemon pytest | `cd daemon && uv run pytest` | 43/43 pass（其中 13 declarations + 17 e2e 验收） |
| web vitest | `cd web && pnpm run test` | 133/133 pass（其中 15 新增） |
| web tsc | `cd web && pnpm exec tsc --noEmit` | 干净 |

## 已完成的工作

按 ADR-0008 落地四件事：

1. 后端 seam：`daemon/posthub/declarations.py` + `daemon/posthub/uploader_wrapper.py` + `daemon/sau_backend.py` HTTP 路由（`/postVideo` / `/postVideoBatch` / `/getAccountDefaults` / `/updateAccountDefaults`）
2. 后端 schema：`daemon/db_init.py` 增量 `ALTER TABLE user_info ADD COLUMN default_platform_fields TEXT`（幂等）
3. 前端 types + registry：`web/src/api/declarations.ts`（单一来源）+ `web/src/api/official.ts`（OAuth 客户端）+ `web/src/api/types.ts`（`PlatformFields` re-export）
4. 前端 UI：`web/src/views/PublishView.tsx`「内容声明」section + `web/src/views/AccountsView.tsx`「默认声明」dialog + `web/src/components/publish/BatchPublishSection.tsx` 每 item 编辑块 + `web/src/components/publish/PlatformDeclarationPicker.tsx` 共享 picker/badge

文档：`docs/adr/0008-platform-declaration-pass-through.md` + `docs/research/2026-08-21-three-platform-aigc-declaration-fields.md` + `CONTEXT.md`（5 条术语 & 透传矩阵表）。

simplify pass 已执行：抽取 `trimPlatformFields` 到 declarations.ts 复用；删除 `useEffectiveDeclarationLabel`、`mergeEffectiveDeclaration`、`parseDefaultPlatformFields`、`ResolvedDeclarations.{tencent,xiaohongshu}_origin`、`posthub_declaration` 写、`BatchItemDeclarationBlock` IIFE → 命名组件等死代码与重复。

## 待办 / 已知 follow-up

ADR-0008 决策三显式延后，需新 issue 跟进：

1. **视频号 DOM wrapper** —— `TencentVideo.__init__` 不接受 `declaration` 形参；上游 `apply_original_statement` 仅尝试三个回避项；PostHub wrapper 当前只 pop 队列不写 class attr。需要 PostHub 自补 DOM 强点「无需标注」候选（spec Phase 1）
2. **小红书 `source` 字段** —— 上游 `xiaohongshu_uploader/main.py` 零代码；wrapper 当前 pop 队列不消费。需要 PostHub DOM wrapper 自补「笔记含AI合成内容 / 自主拍摄 / 来源转载」（spec Phase 3）
3. **多并发下的 thread-local queue 清理** —— `/postVideo` 失败路径未 try/finally 清队列；当前单线程 Flask 串行安全，但若改成 async 或多线程需要 review wrapper 的并发假设（reviewer risk #3）
4. **CHANGELOG v0.1.6 条目** —— 项目 `posthub/__init__.py` 和 `web/package.json` 都 bump 到 0.1.6，但 `CHANGELOG.md` 没有对应条目（reviewer risk #4）
5. **小红书 6 选项 vs 当前 4 选项** —— 调研报告 §2.1 列了 6 个候选；当前 `XIAOHONGSHU_SOURCES` 只 4 个。是否扩列待确认（reviewer risk #6）

## Suggested skills（下一 session）

- **`/simplify`** —— 如果要继续清理现有代码。当前实现已运行一次 simplify pass，仍有 review 提出的「可选」改进未采纳（数据驱动 picker、helper 抽取等）；调用 `/simplify` 可基于新 commit diff 重新跑 4-reviewer + code-simplifier 流程
- **`/code-review`** —— 已在 commit 之后建议调用一次（按 `implement` skill 默认流程）。下一 session 可以直接 `/code-review` 范围指向最新 commit `61dc974`
- **`/implement`** —— 如果用户给了一个新需求（比如「视频号 DOM wrapper 跟进」）直接 `/implement <issue-url>` 续跑。本 issue 主流程已完结，不应再用 `/implement #43`
- **`/publish-release`** —— 如果要把这次合并到发版流程（如打 v0.1.6 tag），调用 `/publish-release` 处理版本号与 changelog

## 引用（已在其他 artifact 中记录，不重复）

- Spec：`docs/specs/platform-declaration-pass-through.md`
- ADR：`docs/adr/0008-platform-declaration-pass-through.md`
- 调研报告：`docs/research/2026-08-21-three-platform-aigc-declaration-fields.md`
- CONTEXT 术语：`CONTEXT.md`（「内容声明 / 平台声明字段 / `platform_fields.<platform>` / `declaration` / `source` / `origin` / 平台默认声明」7 条 + 「内容声明透传」矩阵表）
- Issue 注释：<https://github.com/toRolex/PostHub/issues/43#issuecomment-5368375065>
- Commit：`git log -1 --stat HEAD`（`61dc974`）

## 文件路径速查

新增文件：

- `daemon/posthub/declarations.py`
- `daemon/posthub/uploader_wrapper.py`
- `daemon/tests/test_declarations.py`
- `web/src/api/declarations.ts`
- `web/src/api/declarations.test.ts`
- `web/src/components/publish/PlatformDeclarationPicker.tsx`

修改文件：

- `CONTEXT.md`
- `daemon/db_init.py`
- `daemon/posthub/__init__.py`（版本 bump）
- `daemon/run_backend.py`
- `daemon/sau_backend.py`
- `daemon/tests/test_e2e_acceptance.py`
- `daemon/uv.lock`
- `web/src/api/official.ts`
- `web/src/api/official.test.ts`
- `web/src/api/postVideo.test.ts`
- `web/src/api/types.ts`
- `web/src/components/publish/BatchPublishSection.tsx`
- `web/src/stores/accounts.ts`
- `web/src/stores/accounts.test.ts`
- `web/src/stores/batchPublish.ts`
- `web/src/stores/batchPublish.test.ts`
- `web/src/stores/publish.ts`
- `web/src/types/batch.ts`
- `web/src/views/AccountsView.tsx`
- `web/src/views/PublishView.tsx`
