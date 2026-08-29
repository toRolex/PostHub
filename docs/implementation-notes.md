# Issue #102 Implementation Notes

## 目标

从 `origin/main` 的干净基线交付开发环境原型：bootstrap 层隔离正式应用、可直接运行的 standalone Logic 原型、可信的 synthetic batch-run 状态行为，以及聚焦验证。

## 已冻结边界

- 仅迁移原型入口、两个 TSX 原型、Logic 原型、必要测试与本记录。
- `?prototype=time-picker`、`?prototype=batch-run&variant=A|B|C` 仅在 DEV 生效。
- 原型命中时不得挂载正式 `AppShell`，daemon URL、账号加载、探活与轮询调用均应为 0。
- production build 忽略 prototype 参数，且产物不包含原型模块或 standalone 页面。
- 可重试 item 状态仅为 `failure`、`skipped`、`interrupted`。
- 所有 run、恢复、历史、复制行为均明确为 synthetic/模拟，不宣称正式产品能力。

## 实现进展

- 已读取 Issue #102 与 PR #101，确认旧 PR 为 37 commits / 43 files，不能直接修正其共享历史。
- 已从 `origin/main@24cbfda` 创建 `feature/issue-102-prototype-replacement`；创建时 merge-base 与远程目标分支 head 一致。
- 已把 prototype 参数分派移到 `src/main.tsx` bootstrap；命中原型时仅动态导入目标原型，正式 `App`/`AppShell` 不加载。
- production 下 `resolvePrototype(..., false)` 无条件返回正式应用；退出原型显式删除 `prototype`、`variant`、`runId`。
- 已迁移并修正 time-picker 与 batch-run TSX 原型；batch-run 共用纯状态契约，retry 仅接受 failure/skipped/interrupted，创建新 run 并保留 parent。
- 409 “查看 run-099”真实加载对应 synthetic run；Variant C 选择会与当前可重试集合求交；复制仅在 clipboard 写入成功后提示成功。
- standalone Logic HTML 已移到 `web/prototypes/`，Vite dev 可直接提供、不是 production build input；脚本改为纯 JavaScript，并加入 safe storage、schema 校验、损坏快照清理与页面错误展示。

## Deviations

- 原工作树的 `docs/implementation-notes.md` 来自 PR #101 分支历史，而 `origin/main` 不存在该文件；直接恢复产生 modify/delete 冲突。为遵守“聚焦原型验证记录”要求，未移植 246 行历史运行日志，改为在替代分支新建本任务专属记录。

## 验证记录

- TDD red：bootstrap/route/state/standalone 测试最初因模块缺失、旧 HTML TypeScript 语法及页面标识缺失而失败。
- 聚焦 Vitest：4 files / 24 tests passed。
- 全量 `pnpm test`：17 files / 159 tests passed；现有 cookies tests 仍输出 jsdom navigation stderr，不影响通过。
- `pnpm build`：通过；产物仅正式 `index`/`App` chunks，无 prototype chunk 或 standalone HTML。
- `pnpm test:prototype-smoke`：通过；Vite dev 能提供 standalone URL，production preview 忽略 prototype 参数且 standalone URL 只回 SPA fallback。
- Playwright 有头持久化验证：
  - time-picker Variant B 可见，资源列表无 daemon/getAccounts 请求。
  - batch-run A/B/C 均可见；Variant C partial 仅 2 个 retry checkbox/按钮，complete 后归零；409 按钮打开 `run-099`。
  - standalone happy/error 路径可操作，损坏 JSON 显示可清理错误。
  - production preview `?prototype=batch-run` 显示正式 App，未加载 prototype 资源。
  - DEV 未知 prototype 回正式 App，并按原行为请求 daemon；退出原型后 URL 从 prototype/variant/runId 收口为 `?debug=1`。
- Review 修复：TSX 与 standalone 改用同一份纯 JavaScript batch-run contract，并由 parity test 锁定副本一致；终态 poll 仍先校验未知 run/item 状态；partial synthetic 场景将未确认 running 转为 interrupted，retry 覆盖三类合法状态；storage 快照增加 version gate；“刷新模拟”真正重建当前场景；平台类型复用正式 `Platform` 子集。