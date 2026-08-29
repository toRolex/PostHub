((global) => {
  "use strict";

  const ITEM_STATUSES = new Set([
    "pending",
    "running",
    "success",
    "failure",
    "skipped",
    "interrupted",
    "invalid",
  ]);
  const RUN_STATUSES = new Set([
    "running",
    "completed",
    "completed_with_failures",
    "interrupted",
    "invalid",
  ]);
  const RETRYABLE_ITEM_STATUSES = new Set([
    "failure",
    "skipped",
    "interrupted",
  ]);
  const TERMINAL_RUN_STATUSES = new Set([
    "completed",
    "completed_with_failures",
    "interrupted",
    "invalid",
  ]);

  const BASE_ITEMS = [
    { id: "1", file: "春游.mp4", platform: "douyin", account: "抖音 · 主号", status: "success", scheduled: "今天 14:00" },
    { id: "2", file: "春游.mp4", platform: "xiaohongshu", account: "小红书 · 工作室", status: "failure", reason: "浏览器会话中断", scheduled: "今天 14:00" },
    { id: "3", file: "夜市.mp4", platform: "wechat", account: "视频号 · 运营号", status: "skipped", reason: "超出平台定时窗口", scheduled: "明天 10:30" },
    { id: "4", file: "夜市.mp4", platform: "douyin", account: "抖音 · 主号", status: "success", scheduled: "明天 10:30" },
    { id: "5", file: "雨后.mp4", platform: "xiaohongshu", account: "小红书 · 工作室", status: "interrupted", reason: "轮询中断，状态未确认", scheduled: "明天 18:00" },
    { id: "6", file: "雨后.mp4", platform: "wechat", account: "视频号 · 运营号", status: "pending", scheduled: "明天 18:00" },
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isRetryableItemStatus(status) {
    return RETRYABLE_ITEM_STATUSES.has(status);
  }

  function isTerminalRunStatus(status) {
    return TERMINAL_RUN_STATUSES.has(status);
  }

  function retryableItems(items) {
    return items.filter((item) => isRetryableItemStatus(item.status));
  }

  function intersectRetrySelection(selected, items) {
    const retryableIds = new Set(retryableItems(items).map((item) => item.id));
    return selected.filter((id) => retryableIds.has(id));
  }

  function retryRun(parent, newRunId, requestedItemIds) {
    if (!isTerminalRunStatus(parent.status)) {
      throw new Error("只有终态 run 可以重试");
    }
    const requested = requestedItemIds ? new Set(requestedItemIds) : null;
    const items = retryableItems(parent.items)
      .filter((item) => !requested || requested.has(item.id))
      .map((item) => {
        const next = { ...item, status: "pending", retriedFrom: parent.runId };
        delete next.reason;
        return next;
      });
    if (items.length === 0) throw new Error("没有可重试项");
    return {
      runId: newRunId,
      parentRunId: parent.runId,
      status: "running",
      items,
    };
  }

  function invalidRun(local, message, invalidItem) {
    return {
      ...local,
      status: "invalid",
      error: message,
      items: invalidItem
        ? local.items.map((item) =>
            item.id === invalidItem.id
              ? { ...item, status: "invalid", reason: message }
              : item,
          )
        : local.items,
    };
  }

  function mergePollResult(local, remote) {
    if (!RUN_STATUSES.has(remote.status)) {
      return invalidRun(local, `未知 run 状态：${String(remote.status)}`);
    }
    const invalidRemoteItem = remote.items.find(
      (item) => !ITEM_STATUSES.has(item.status),
    );
    if (invalidRemoteItem) {
      return invalidRun(
        local,
        `未知 item 状态：${String(invalidRemoteItem.status)}`,
        invalidRemoteItem,
      );
    }
    if (isTerminalRunStatus(local.status)) return local;

    const remoteById = new Map(remote.items.map((item) => [item.id, item]));
    const items = local.items.map((localItem) => {
      const remoteItem = remoteById.get(localItem.id);
      if (!remoteItem) return localItem;
      return {
        ...localItem,
        ...remoteItem,
        reason:
          remoteItem.reason ??
          (isRetryableItemStatus(remoteItem.status)
            ? localItem.reason
            : undefined),
      };
    });
    return { ...local, ...remote, items };
  }

  function getSyntheticRun(runId) {
    if (runId === "run-099") {
      return {
        runId,
        status: "running",
        items: BASE_ITEMS.map((item, index) => ({
          ...item,
          status: index < 2 ? "success" : index === 2 ? "running" : "pending",
          reason: undefined,
        })),
      };
    }
    if (runId === "run-077") {
      return {
        runId,
        status: "interrupted",
        items: BASE_ITEMS.map((item, index) => ({
          ...item,
          status: index === 0 ? "success" : "interrupted",
          reason: index === 0 ? undefined : "守护进程重启时未完成",
        })),
      };
    }
    return {
      runId,
      status: "completed_with_failures",
      items: clone(BASE_ITEMS),
    };
  }

  global.PostHubBatchRunContract = Object.freeze({
    isRetryableItemStatus,
    isTerminalRunStatus,
    retryableItems,
    intersectRetrySelection,
    retryRun,
    mergePollResult,
    getSyntheticRun,
  });
})(globalThis);
