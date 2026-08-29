import { describe, expect, it } from "vitest";

import {
  getSyntheticRun,
  intersectRetrySelection,
  isRetryableItemStatus,
  mergePollResult,
  retryRun,
  type BatchRun,
  type ItemStatus,
} from "./batchRunState";

const ITEM_STATUSES: ItemStatus[] = [
  "pending",
  "running",
  "success",
  "failure",
  "skipped",
  "interrupted",
];

describe("批量 run 原型状态契约", () => {
  it.each(ITEM_STATUSES)("冻结 %s 的 retry eligibility", (status) => {
    expect(isRetryableItemStatus(status)).toBe(
      status === "failure" || status === "skipped" || status === "interrupted",
    );
  });

  it("retry 创建新 run，保留 parent，且不修改旧 run", () => {
    const parent = getSyntheticRun("run-101");
    const snapshot = structuredClone(parent);

    const retried = retryRun(parent, "run-102");

    expect(retried.runId).toBe("run-102");
    expect(retried.parentRunId).toBe("run-101");
    expect(retried.items.map((item) => item.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(retried.items.every((item) => item.reason === undefined)).toBe(true);
    expect(retried.items.every((item) => item.retriedFrom === "run-101")).toBe(true);
    expect(parent).toEqual(snapshot);
  });

  it("retry 会忽略 success、pending、running，即使调用方传入它们", () => {
    const parent = getSyntheticRun("run-101");
    const retried = retryRun(parent, "run-102", ["1", "2", "5", "6"]);

    expect(retried.items.map((item) => item.id)).toEqual(["2", "5"]);
  });

  it("poll 成功会清除旧失败原因", () => {
    const local = getSyntheticRun("run-099");
    const merged = mergePollResult(local, {
      runId: "run-101",
      status: "completed",
      items: local.items.map((item) => ({ ...item, status: "success", reason: undefined })),
    });

    expect(merged.items.every((item) => item.reason === undefined)).toBe(true);
  });

  it("终态不会被迟到的 running 响应回退", () => {
    const terminal = getSyntheticRun("run-101");
    const late = mergePollResult(terminal, {
      ...terminal,
      status: "running",
      items: terminal.items.map((item) => ({ ...item, status: "running" })),
    });

    expect(late).toEqual(terminal);
  });

  it("未知 run 或 item 状态进入明确 invalid 状态", () => {
    const local = getSyntheticRun("run-099");
    const invalidRun = mergePollResult(local, {
      ...local,
      status: "queued" as BatchRun["status"],
    });
    const invalidItem = mergePollResult(local, {
      ...local,
      items: [{ ...local.items[0], status: "cancelled" as ItemStatus }],
    });

    expect(invalidRun.status).toBe("invalid");
    expect(invalidRun.error).toContain("queued");
    expect(invalidItem.status).toBe("invalid");
    expect(invalidItem.items[0].status).toBe("invalid");
    expect(invalidItem.items[0].reason).toContain("cancelled");
  });

  it("终态也会把未知迟到状态升级为明确 invalid", () => {
    const terminal = getSyntheticRun("run-101");
    const invalidRun = mergePollResult(terminal, {
      ...terminal,
      status: "queued" as BatchRun["status"],
    });
    const invalidUnmatchedItem = mergePollResult(terminal, {
      ...terminal,
      items: [{
        ...terminal.items[0],
        id: "remote-only",
        status: "cancelled" as ItemStatus,
      }],
    });

    expect(invalidRun.status).toBe("invalid");
    expect(invalidUnmatchedItem.status).toBe("invalid");
    expect(invalidUnmatchedItem.error).toContain("cancelled");
  });

  it("409 查看操作加载服务端返回的 runId", () => {
    expect(getSyntheticRun("run-099").runId).toBe("run-099");
  });

  it("场景变化后选择集合只保留当前可重试项", () => {
    const partial = getSyntheticRun("run-101");
    const selected = partial.items.map((item) => item.id);
    const running = getSyntheticRun("run-099");
    const complete = mergePollResult(running, {
      ...running,
      status: "completed",
      items: running.items.map((item) => ({ ...item, status: "success", reason: undefined })),
    });

    expect(intersectRetrySelection(selected, complete.items)).toEqual([]);
  });
});
