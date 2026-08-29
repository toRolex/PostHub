# Issue #104 实现记录

## 目标

收口 PR #103 的开发原型运行时契约与浏览器验收：协议漂移安全失败、standalone 故障可见、production 隔离可执行验证，并接入可重复的 `pnpm` CI 门禁。

## 稳定决策

- Synthetic run/poll/storage 仅为 throwaway prototype，不定义正式 PostHub 领域模型。
- Poll 使用完整快照语义；所有不可信输入先经过共享 `parseBatchRun(unknown)`。
- 非法 poll 保留本地 `runId`、`parentRunId` 与 items，只进入可见 `invalid` 终态。
- Standalone 只负责 snapshot version wrapper 和 safe localStorage I/O，run payload 复用共享 validator。
- Browser smoke 保留单文件入口，使用 `web` 项目内锁版本 Playwright Chromium，并自行执行 fresh production build。
- 保留旧工作树 `docs/implementation-notes.md` 的未提交内容；本任务在 replacement worktree 实施。

## 测试 seams

- Contract：公开 parser 与 synthetic poll merge 返回值。
- Standalone：浏览器可见 alert、恢复结果与 storage 反馈。
- DEV prototype：真实 Vite URL、可见行为、导航，以及 daemon/account/Tauri 外部调用计数。
- Production：fresh build 后真实 preview、正式 App 可见性、prototype 缺失及 assets 负向扫描。
- 不测试 React 内部 state、私有调用顺序或 CSS class。

## 实施日志

- 2026-08-30：确认 PR #103 replacement worktree `feature/issue-102-prototype-replacement` 为实现基线；基线为 17 个 Vitest 文件、159 个测试、build 与旧文本 smoke 通过。
- 2026-08-30：共享 contract 完整校验 run/item schema、平台枚举、可选字段类型与唯一 item ID；poll 强制同 runId 与完整 item 集合。
- 2026-08-30：reason 规则收紧；远端显式 reason 优先，`failure` 离开后无新 reason 则清除旧错误。
- 2026-08-30：standalone 在加载 contract 前安装错误展示；处理请求失败、脚本异常、导出缺失和初始化异常；storage 复用共享 validator。
- 2026-08-30：standalone 渲染改用 DOM API/`textContent`，避免 snapshot 字符串进入 `innerHTML`。
- 2026-08-30：通过 `pnpm` 添加并锁定 `playwright@1.61.0`，安装 Playwright Chromium。
- 2026-08-30：单文件 smoke 改为真实 Chromium 执行；覆盖 DEV time-picker A/B/C、batch-run A/B/C、409/retry/退出、正式 App fallback 与副作用隔离、standalone contract/storage 错误、production preview 和 assets 负向扫描。
- 2026-08-30：CI 增加 Chromium 安装、全部 web tests 和自包含 browser smoke，保留 daemon import smoke。

## Deviations

- `modern-web-guidance` 的外部 `npx` 执行被权限策略拒绝；未绕过，改用仓库模式与 Playwright/Vite 官方文档。
- Playwright 与 Chromium 安装初次被权限门禁拦截；获得用户明确批准后通过 `pnpm` 完成。

## 最终复现命令

```bash
pnpm --dir web install --frozen-lockfile
pnpm --dir web exec playwright install chromium
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:prototype-smoke
```

Linux CI 使用：

```bash
pnpm --dir web exec playwright install --with-deps chromium
```

## 最终结果

- Web tests：17 个测试文件、182 个测试通过；`cookies.test.ts` 保留既有 jsdom navigation stderr。
- Build：`tsc --noEmit` 与 Vite production build 通过。
- Browser smoke：项目内 Playwright Chromium 真实执行通过。

## 非目标

- 不实现正式 batch runner、poll/retry API、SQLite history、调度器或 worker。
- 不修改正式 PostHub 领域模型、`CONTEXT.md` 或 ADR。
- 不引入 Playwright Test config、reporter 或多浏览器矩阵。
