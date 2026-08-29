# Issue #104 Implementation Notes

## 目标

收口 PR #103 的开发原型运行时契约与浏览器验收，使协议漂移安全失败、standalone 故障可见、production 不暴露原型，并由项目内 `pnpm` 流程重复验证。

## 稳定边界

- Synthetic run、poll、retry 与单快照 storage 仅为 throwaway prototype，不定义正式 PostHub 领域能力。
- Poll 是完整快照：远端 `runId` 必须与当前 run 相同，item ID 唯一且集合完全一致。
- 不可信 run 输入统一由共享 `parseBatchRun(unknown)` 校验；TSX 与 standalone contract 副本保持 parity。
- 非法 poll 保留当前 `runId`、parent 与 items，仅转为可见的 `invalid` 终态并停止轮询。
- Standalone 只处理 snapshot version wrapper 与 safe localStorage I/O，run payload 复用共享 validator。
- Browser smoke 保持单文件入口，使用 `web` 项目内 Playwright Chromium；不引入 Playwright Test config、reporter 或多浏览器矩阵。
- Production build 忽略 prototype 参数，且产物不得包含可识别 prototype 模块、标识或文案。

## DEV 访问 URL

启动：

```bash
pnpm --dir web dev --host 127.0.0.1
```

- Time picker A：<http://127.0.0.1:5173/?prototype=time-picker&variant=A>
- Time picker B：<http://127.0.0.1:5173/?prototype=time-picker&variant=B>
- Time picker C：<http://127.0.0.1:5173/?prototype=time-picker&variant=C>
- Batch run A：<http://127.0.0.1:5173/?prototype=batch-run&variant=A>
- Batch run B：<http://127.0.0.1:5173/?prototype=batch-run&variant=B>
- Batch run C：<http://127.0.0.1:5173/?prototype=batch-run&variant=C>
- Standalone Logic：<http://127.0.0.1:5173/prototypes/batch-run-state-machine.html>

## 验证命令

均从仓库根执行：

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

`test:prototype-smoke` 自行执行 fresh `pnpm run build`，该 build 已包含 `tsc --noEmit`。

## 最终结果

- Web tests、TypeScript 检查与 production build 通过。
- 项目内 Playwright Chromium browser smoke 通过；覆盖 DEV time-picker A/B/C、batch-run A/B/C、409/retry/退出接线、正式 App 隔离、standalone contract/storage 错误路径、production preview 与 assets 负向约束。

## 非目标

- 不实现正式 batch runner、poll/retry API、SQLite history、调度器或 worker。
- 不改变正式 PostHub“无自研任务状态机 / 调度器 / 重试”领域模型。
- 不全面 E2E 化两个原型的所有控件与视觉状态。
- 不修改 `CONTEXT.md`，不新增 ADR，不重构无关 CI、正式 App 或 daemon。
