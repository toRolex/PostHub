/**
 * BatchPublishSection 抽屉矩阵 UI 测试（issue #39）。
 *
 * 注：本项目未装 @testing-library/react，本测试只覆盖纯逻辑 helper
 * （summarizeItem / summarizeDailyTimes）。DOM 渲染与交互（展开/折叠、
 * openPreview 触发、itemResults 逐项渲染）需 dev 环境手动验证
 * （见 acceptance criteria 第 1 条）。
 */

import { describe, expect, it } from "vitest";
import { summarizeItem, summarizeDailyTimes } from "./BatchPublishSection";
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
    const s = summarizeItem(
      mkItem({ accountIdsByPlatform: {} }),
      new Set(),
    );
    expect(s.accountSummary).toBe("未选账号");
    expect(s.totalAccounts).toBe(0);
  });

  it("多平台多账号 → accountSummary = 'N 账号 / M 平台'", () => {
    const s = summarizeItem(
      mkItem({
        accountIdsByPlatform: {
          douyin: ["d1.json", "d2.json"],
          xiaohongshu: ["x1.json"],
        },
      }),
      new Set(),
    );
    expect(s.totalAccounts).toBe(3);
    expect(s.platformCount).toBe(2);
    expect(s.accountSummary).toBe("3 账号 / 2 平台");
  });

  it("mode='immediate' → modeSummary = '立即'", () => {
    const s = summarizeItem(mkItem({ mode: "immediate" }), new Set());
    expect(s.modeSummary).toBe("立即");
    expect(s.timeOfDayLabel).toBeNull();
    expect(s.startDaysLabel).toBeNull();
  });

  it("mode='timer' + timeOfDay='10:00' + startDays=0 → 显示 '定时 10:00 · 起始 +0 天'", () => {
    const s = summarizeItem(
      mkItem({ mode: "timer", timeOfDay: "10:00", startDays: 0 }),
      new Set(["10:00"]),
    );
    expect(s.modeSummary).toBe("定时");
    expect(s.timeOfDayLabel).toBe("10:00");
    expect(s.startDaysLabel).toBe("+0 天");
  });

  it("mode='timer' 但 timeOfDay 未选 → modeSummary='定时 (待选时刻)' 标记未配置", () => {
    const s = summarizeItem(
      mkItem({ mode: "timer", timeOfDay: undefined, startDays: 0 }),
      new Set(),
    );
    expect(s.modeSummary).toBe("定时 (待选时刻)");
    expect(s.timeOfDayLabel).toBeNull();
    expect(s.startDaysLabel).toBe("+0 天");
  });

  it("accountSummary 在 dailyTimesSet 内影响显示与否无关", () => {
    const s = summarizeItem(
      mkItem({
        accountIdsByPlatform: { douyin: ["d.json"] },
        mode: "timer",
        timeOfDay: "10:00",
      }),
      new Set(["10:00"]),
    );
    expect(s.accountSummary).toBe("1 账号 / 1 平台");
    expect(s.timeOfDayLabel).toBe("10:00");
  });
});

describe("BatchPublishSection · summarizeDailyTimes（顶部 chip 显示顺序）", () => {
  it("空池 → 空数组", () => {
    expect(summarizeDailyTimes([])).toEqual([]);
  });

  it("按 HH:MM 字典序排序（'14:00' < '10:00'）", () => {
    const sorted = summarizeDailyTimes(["14:00", "10:00", "11:30"]);
    expect(sorted).toEqual(["10:00", "11:30", "14:00"]);
  });

  it("去重 + 排序", () => {
    const sorted = summarizeDailyTimes(["10:00", "10:00", "09:00"]);
    expect(sorted).toEqual(["09:00", "10:00"]);
  });
});