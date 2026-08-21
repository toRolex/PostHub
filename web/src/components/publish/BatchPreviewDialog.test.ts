/**
 * BatchPreviewDialog 受控哑组件测试（issue #39）。
 *
 * 注：本项目未装 @testing-library/react，本测试只覆盖纯逻辑 helper
 * （buildPreviewRows）。DOM 渲染与回调触发（onConfirm/onCancel）需 dev 环境手动验证
 * （见 acceptance criteria 第 2 条）。
 *
 * 覆盖：
 * - buildPreviewRows：每视频×每账号展开为 PreviewRow；itemKey 稳定。
 * - 字段透传：mode / timeOfDay / startDays / platform。
 */

import { describe, expect, it } from "vitest";
import { buildPreviewRows } from "./BatchPreviewDialog";
import type { BatchItem } from "../../types/batch";

function mkItem(over: Partial<BatchItem>): BatchItem {
  return {
    filePath: "a.mp4",
    title: "t",
    caption: "",
    tags: "",
    accountIdsByPlatform: {},
    mode: "immediate",
    ...over,
  };
}

describe("BatchPreviewDialog · buildPreviewRows（纯逻辑）", () => {
  it("items 为空 → 返回空数组", () => {
    expect(buildPreviewRows([])).toEqual([]);
  });

  it("单视频×单平台×单账号 → 1 行；字段透传", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "a.mp4",
        accountIdsByPlatform: { douyin: ["d1.json"] },
        mode: "immediate",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemKey: "a.mp4|d1.json",
      fileName: "a.mp4",
      platform: "douyin",
      cookieFile: "d1.json",
      mode: "immediate",
      timeOfDay: undefined,
      startDays: undefined,
    });
  });

  it("单视频×多平台多账号 → 全部笛卡尔展开为行", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "a.mp4",
        accountIdsByPlatform: {
          douyin: ["d1.json", "d2.json"],
          xiaohongshu: ["x1.json"],
        },
        mode: "immediate",
      }),
    ]);
    expect(rows).toHaveLength(3);
    const keys = rows.map((r) => r.itemKey).sort();
    expect(keys).toEqual(["a.mp4|d1.json", "a.mp4|d2.json", "a.mp4|x1.json"]);
  });

  it("多视频 → 行数 = Σ (item × 每平台账号)", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "a.mp4",
        accountIdsByPlatform: { douyin: ["d.json"] },
      }),
      mkItem({
        filePath: "b.mp4",
        accountIdsByPlatform: { douyin: ["d.json"], xiaohongshu: ["x.json"] },
      }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.fileName === "a.mp4")).toHaveLength(1);
    expect(rows.filter((r) => r.fileName === "b.mp4")).toHaveLength(2);
  });

  it("mode='timer' → timeOfDay / startDays 透传", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "a.mp4",
        accountIdsByPlatform: { douyin: ["d.json"] },
        mode: "timer",
        timeOfDay: "10:00",
        startDays: 1,
      }),
    ]);
    expect(rows[0].mode).toBe("timer");
    expect(rows[0].timeOfDay).toBe("10:00");
    expect(rows[0].startDays).toBe(1);
  });

  it("accountIdsByPlatform 字段空数组时该平台不产出行", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "a.mp4",
        accountIdsByPlatform: { douyin: [], xiaohongshu: ["x.json"] },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("xiaohongshu");
  });

  it("itemKey 与 store itemResults.itemKey 稳定一致（filePath + '|' + cookieFile）", () => {
    const rows = buildPreviewRows([
      mkItem({
        filePath: "video_x.mp4",
        accountIdsByPlatform: { wechat: ["w_a.json"] },
      }),
    ]);
    expect(rows[0].itemKey).toBe("video_x.mp4|w_a.json");
  });
});