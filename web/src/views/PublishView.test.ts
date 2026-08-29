import { describe, expect, it } from "vitest";
import {
  isRetryableRunItemStatus,
  retryableRunItemIds,
  runItemDiagnostics,
} from "./PublishView";

describe("最近运行 item 诊断", () => {
  it("把 warning 与 debug screenshot 保留在对应 item 详情", () => {
    expect(
      runItemDiagnostics({
        warnings: ["入口未渲染"],
        debugScreenshots: ["/tmp/xhs-source.png"],
      }),
    ).toEqual(["告警：入口未渲染", "调试截图：/tmp/xhs-source.png"]);
  });

  it("旧 run 没有诊断时不渲染占位内容", () => {
    expect(runItemDiagnostics(undefined)).toEqual([]);
  });

  it("只允许 failure/skipped/interrupted item retry", () => {
    expect(["failed", "skipped", "interrupted", "success", "pending", "running"].map(isRetryableRunItemStatus)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(
      retryableRunItemIds([
        { itemId: "success", status: "success" },
        { itemId: "failed", status: "failed" },
        { itemId: "skipped", status: "skipped" },
        { itemId: "running", status: "running" },
      ]),
    ).toEqual(["failed", "skipped"]);
  });
});
