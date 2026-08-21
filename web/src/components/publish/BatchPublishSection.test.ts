/**
 * BatchPublishSection 抽屉矩阵 UI 测试（issue #39）。
 *
 * 注：本项目未装 @testing-library/react，本测试只覆盖纯逻辑 helper
 * （summarizeItem）。DOM 渲染与交互（展开/折叠、openPreview 触发、
 * itemResults 逐项渲染）需 dev 环境手动验证（见 acceptance criteria 第 1 条）。
 */

import { describe, expect, it } from "vitest";
import { summarizeItem } from "./BatchPublishSection";
import type { BatchItem } from "../../types/batch";

function mkItem(over: Partial<BatchItem>): BatchItem {
  return {
    filePath: "a.mp4",
    title: "标题",
    caption: "",
    tags: "",
    accountIdsByPlatform: {},
    mode: "immediate",
    ...over,
  };
}

describe("BatchPublishSection · summarizeItem（折叠态摘要）", () => {
  it("无账号勾选 → accountSummary = '未选账号'", () => {
    const s = summarizeItem(mkItem({ accountIdsByPlatform: {} }));
    expect(s.accountSummary).toBe("未选账号");
  });

  it("多平台多账号 → accountSummary = 'N 账号 / M 平台'", () => {
    const s = summarizeItem(
      mkItem({
        accountIdsByPlatform: {
          douyin: ["d1.json", "d2.json"],
          xiaohongshu: ["x1.json"],
        },
      }),
    );
    expect(s.accountSummary).toBe("3 账号 / 2 平台");
  });

  it("mode='immediate' → modeChip = '立即'", () => {
    const s = summarizeItem(mkItem({ mode: "immediate" }));
    expect(s.modeChip).toBe("立即");
  });

  it("mode='timer' + timeOfDay='10:00' → modeChip = '定时 · 10:00'", () => {
    const s = summarizeItem(
      mkItem({ mode: "timer", timeOfDay: "10:00", startDays: 0 }),
    );
    expect(s.modeChip).toBe("定时 · 10:00");
  });

  it("mode='timer' 但 timeOfDay 未选 → modeChip='定时 (待选时刻)' 标记未配置", () => {
    const s = summarizeItem(
      mkItem({ mode: "timer", timeOfDay: undefined, startDays: 0 }),
    );
    expect(s.modeChip).toBe("定时 (待选时刻)");
  });

  it("有账号 + timer 全配置 → accountSummary / modeChip 都填充", () => {
    const s = summarizeItem(
      mkItem({
        accountIdsByPlatform: { douyin: ["d.json"] },
        mode: "timer",
        timeOfDay: "10:00",
      }),
    );
    expect(s.accountSummary).toBe("1 账号 / 1 平台");
    expect(s.modeChip).toBe("定时 · 10:00");
  });
});