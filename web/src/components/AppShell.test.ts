import { describe, expect, it } from "vitest";
import {
  nextRunPollDelay,
  runProgressLabel,
  runStatusMeta,
  shouldRefreshRun,
} from "./AppShell";

describe("顶部最近 run 状态条", () => {
  it("pending/running/completed 使用真实生命周期文案", () => {
    expect(runStatusMeta("pending")?.label).toBe("最近运行 待执行");
    expect(runStatusMeta("running")?.label).toBe("最近运行 执行中");
    expect(runStatusMeta("running")?.pulse).toBe(true);
    expect(runStatusMeta("completed")?.label).toBe("最近运行 已完成");
  });

  it("顶部进度只使用 accepted/查询 API 返回的后端汇总", () => {
    expect(runProgressLabel(null, 3)).toBe("完成 0/3");
    expect(
      runProgressLabel(
        {
          itemCount: 3,
          pendingCount: 0,
          runningCount: 1,
          successCount: 1,
          failedCount: 1,
          completedCount: 2,
        },
        99,
      ),
    ).toBe("完成 2/3");
    expect(runProgressLabel(null, null)).toBeNull();
  });

  it("没有恢复到 run 时不显示状态条", () => {
    expect(runStatusMeta(null)).toBeNull();
  });

  it("completed run 不再持续轮询，部分成功也是终态", () => {
    expect(shouldRefreshRun("completed")).toBe(false);
    expect(shouldRefreshRun("completed_with_failures")).toBe(false);
    expect(shouldRefreshRun("pending")).toBe(true);
    expect(shouldRefreshRun("running")).toBe(true);
    expect(shouldRefreshRun(null)).toBe(true);
  });

  it("部分成功显示明确状态文案", () => {
    expect(runStatusMeta("completed_with_failures")?.label).toBe("最近运行 部分成功");
  });

  it("轮询从 2 秒起步，无变化指数退避但上限 10 秒，有变化重置", () => {
    expect(nextRunPollDelay(2000, false)).toBe(4000);
    expect(nextRunPollDelay(8000, false)).toBe(10000);
    expect(nextRunPollDelay(10000, false)).toBe(10000);
    expect(nextRunPollDelay(10000, true)).toBe(2000);
  });
});
