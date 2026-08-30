import { describe, expect, it } from "vitest";

import {
  getSyntheticRun,
  intersectRetrySelection,
  isRetryableItemStatus,
  mergePollResult,
  parseBatchRun,
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

function pollSnapshot(local: BatchRun): BatchRun {
  return structuredClone(local);
}

function expectInvalidPoll(result: BatchRun, local: BatchRun, message: string): void {
  expect(result.status).toBe("invalid");
  expect(result.runId).toBe(local.runId);
  expect(result.parentRunId).toBe(local.parentRunId);
  expect(result.items).toEqual(local.items);
  expect(result.error).toContain(message);
}

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

  it("解析完整合法的 run snapshot", () => {
    const snapshot = getSyntheticRun("run-101");

    expect(parseBatchRun(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it.each([
    ["非对象", null, "run 必须是对象"],
    ["缺少 items", { runId: "run-101", status: "running" }, "items 必须是数组"],
    ["runId 类型错误", { runId: 101, status: "running", items: [] }, "runId"],
    ["run 状态未知", { runId: "run-101", status: "queued", items: [] }, "queued"],
  ])("拒绝%s", (_label, candidate, message) => {
    const parsed = parseBatchRun(candidate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it.each([
    ["缺少 platform", { platform: undefined }, "platform"],
    ["缺少 account", { account: undefined }, "account"],
    ["缺少 scheduled", { scheduled: undefined }, "scheduled"],
    ["非法平台", { platform: "kuaishou" }, "kuaishou"],
    ["未知 item 状态", { status: "cancelled" }, "cancelled"],
    ["reason 类型错误", { reason: 500 }, "reason"],
  ])("拒绝 item %s", (_label, patch, message) => {
    const candidate: unknown = structuredClone(getSyntheticRun("run-101"));
    const items = (candidate as { items: Record<string, unknown>[] }).items;
    items[0] = { ...items[0], ...patch };

    const parsed = parseBatchRun(candidate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("拒绝重复 item ID", () => {
    const candidate = getSyntheticRun("run-101");
    candidate.items[1].id = candidate.items[0].id;

    const parsed = parseBatchRun(candidate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("重复 item ID");
  });

  it("合法完整 poll 会按同一 run 和完整 item 集合合并", () => {
    const local = getSyntheticRun("run-099");
    const remote = pollSnapshot(local);
    remote.status = "completed";
    remote.items = remote.items.map((item) => ({ ...item, status: "success", reason: undefined }));

    const merged = mergePollResult(local, remote);

    expect(merged.status).toBe("completed");
    expect(merged.runId).toBe(local.runId);
    expect(merged.items.every((item) => item.status === "success")).toBe(true);
  });

  it.each([
    ["非对象", null, "run 必须是对象"],
    ["缺失 items", { items: undefined }, "items 必须是数组"],
    ["runId 不匹配", { runId: "run-other" }, "runId 不匹配"],
  ])("非法 poll（%s）保留本地身份和 items", (_label, patch, message) => {
    const local = getSyntheticRun("run-099");
    const remote = patch === null ? null : { ...pollSnapshot(local), ...patch };

    expectInvalidPoll(mergePollResult(local, remote), local, message);
  });

  it.each([
    ["重复", (remote: BatchRun) => { remote.items[1].id = remote.items[0].id; }, "重复 item ID"],
    ["遗漏", (remote: BatchRun) => { remote.items.pop(); }, "item ID 集合不完整"],
    ["新增", (remote: BatchRun) => { remote.items.push({ ...remote.items[0], id: "remote-only" }); }, "item ID 集合不完整"],
  ])("拒绝%s item ID", (_label, mutate, message) => {
    const local = getSyntheticRun("run-099");
    const remote = pollSnapshot(local);
    mutate(remote);

    expectInvalidPoll(mergePollResult(local, remote), local, message);
  });

  it.each([
    ["success", "success"],
    ["skipped", "skipped"],
    ["interrupted", "interrupted"],
  ] as const)("failure → %s 且远端无新 reason 时清除旧失败原因", (_label, status) => {
    const local = getSyntheticRun("run-099");
    const failed = { ...local.items[1], status: "failure" as const, reason: "旧失败原因" };
    local.items[1] = failed;
    const remote = pollSnapshot(local);
    const remoteItem = remote.items.find((item) => item.id === failed.id)!;
    remoteItem.status = status;
    delete remoteItem.reason;

    const merged = mergePollResult(local, remote);

    expect(merged.items.find((item) => item.id === failed.id)?.reason).toBeUndefined();
  });

  it("远端显式 reason 覆盖旧失败原因", () => {
    const local = getSyntheticRun("run-099");
    const failed = { ...local.items[1], status: "failure" as const, reason: "旧失败原因" };
    local.items[1] = failed;
    const remote = pollSnapshot(local);
    const remoteItem = remote.items.find((item) => item.id === failed.id)!;
    remoteItem.status = "success";
    remoteItem.reason = "远端审计说明";

    const merged = mergePollResult(local, remote);

    expect(merged.items.find((item) => item.id === failed.id)?.reason).toBe("远端审计说明");
  });

  it("合法 poll 保留本地 parent 身份", () => {
    const local = getSyntheticRun("run-099");
    local.parentRunId = "run-parent";
    const remote = pollSnapshot(local);
    remote.parentRunId = "remote-parent";

    const merged = mergePollResult(local, remote);

    expect(merged.parentRunId).toBe("run-parent");
  });

  it("终态不会被迟到的合法 running 响应回退", () => {
    const terminal = getSyntheticRun("run-101");
    const remote = pollSnapshot(terminal);
    remote.status = "running";
    remote.items = remote.items.map((item) => ({ ...item, status: "running" }));

    expect(mergePollResult(terminal, remote)).toEqual(terminal);
  });

  it("终态收到非法迟到响应仍进入明确 invalid", () => {
    const terminal = getSyntheticRun("run-101");
    const remote = { ...pollSnapshot(terminal), status: "queued" };

    expectInvalidPoll(mergePollResult(terminal, remote), terminal, "queued");
  });

  it("409 查看操作加载服务端返回的 runId", () => {
    expect(getSyntheticRun("run-099").runId).toBe("run-099");
  });

  it("场景变化后选择集合只保留当前可重试项", () => {
    const partial = getSyntheticRun("run-101");
    const selected = partial.items.map((item) => item.id);
    const running = getSyntheticRun("run-099");
    const remote = pollSnapshot(running);
    remote.status = "completed";
    remote.items = remote.items.map((item) => ({ ...item, status: "success", reason: undefined }));
    const complete = mergePollResult(running, remote);

    expect(intersectRetrySelection(selected, complete.items)).toEqual([]);
  });
});
