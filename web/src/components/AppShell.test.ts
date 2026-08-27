import { describe, expect, it } from "vitest";
import { runStatusMeta } from "./AppShell";

describe("顶部最近 run 状态条", () => {
  it("pending/running/completed 使用真实生命周期文案", () => {
    expect(runStatusMeta("pending")?.label).toBe("最近运行 待执行");
    expect(runStatusMeta("running")?.label).toBe("最近运行 执行中");
    expect(runStatusMeta("running")?.pulse).toBe(true);
    expect(runStatusMeta("completed")?.label).toBe("最近运行 已完成");
  });

  it("没有恢复到 run 时不显示状态条", () => {
    expect(runStatusMeta(null)).toBeNull();
  });
});
