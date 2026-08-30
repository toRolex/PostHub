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
  const PLATFORMS = new Set(["douyin", "xiaohongshu", "wechat"]);
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

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function requiredString(value, path) {
    if (typeof value !== "string" || value.trim() === "") {
      return `${path} 必须是非空字符串`;
    }
    return null;
  }

  function optionalString(value, path) {
    if (value !== undefined && typeof value !== "string") {
      return `${path} 必须是字符串`;
    }
    return null;
  }

  function parseBatchRun(candidate) {
    try {
      if (!isObject(candidate)) {
        return { ok: false, error: "run 必须是对象" };
      }

      const runIdError = requiredString(candidate.runId, "runId");
      if (runIdError) return { ok: false, error: runIdError };
      if (!RUN_STATUSES.has(candidate.status)) {
        return { ok: false, error: `未知 run 状态：${String(candidate.status)}` };
      }
      if (!Array.isArray(candidate.items)) {
        return { ok: false, error: "items 必须是数组" };
      }

      for (const field of ["parentRunId", "error"]) {
        const fieldError = optionalString(candidate[field], field);
        if (fieldError) return { ok: false, error: fieldError };
      }

      const itemIds = new Set();
      for (let index = 0; index < candidate.items.length; index += 1) {
        const item = candidate.items[index];
        const path = `items[${index}]`;
        if (!isObject(item)) {
          return { ok: false, error: `${path} 必须是对象` };
        }
        for (const field of ["id", "file", "account", "scheduled"]) {
          const fieldError = requiredString(item[field], `${path}.${field}`);
          if (fieldError) return { ok: false, error: fieldError };
        }
        if (!PLATFORMS.has(item.platform)) {
          return { ok: false, error: `未知 platform：${String(item.platform)}` };
        }
        if (!ITEM_STATUSES.has(item.status)) {
          return { ok: false, error: `未知 item 状态：${String(item.status)}` };
        }
        for (const field of ["reason", "retriedFrom"]) {
          const fieldError = optionalString(item[field], `${path}.${field}`);
          if (fieldError) return { ok: false, error: fieldError };
        }
        if (itemIds.has(item.id)) {
          return { ok: false, error: `重复 item ID：${item.id}` };
        }
        itemIds.add(item.id);
      }

      return { ok: true, value: candidate };
    } catch (error) {
      return {
        ok: false,
        error: `run 校验失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
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

  function invalidRun(local, message) {
    return {
      ...local,
      status: "invalid",
      error: message,
    };
  }

  function sameItemIds(localItems, remoteItems) {
    if (localItems.length !== remoteItems.length) return false;
    const localIds = new Set(localItems.map((item) => item.id));
    return remoteItems.every((item) => localIds.has(item.id));
  }

  function mergedReason(localItem, remoteItem) {
    if (remoteItem.reason !== undefined) return remoteItem.reason;
    if (localItem.status === "failure" && remoteItem.status !== "failure") {
      return undefined;
    }
    return isRetryableItemStatus(remoteItem.status) ? localItem.reason : undefined;
  }

  function mergePollResult(local, remoteInput) {
    const parsed = parseBatchRun(remoteInput);
    if (!parsed.ok) return invalidRun(local, parsed.error);

    const remote = parsed.value;
    if (remote.runId !== local.runId) {
      return invalidRun(
        local,
        `poll runId 不匹配：期望 ${local.runId}，收到 ${remote.runId}`,
      );
    }
    if (!sameItemIds(local.items, remote.items)) {
      return invalidRun(local, "poll item ID 集合不完整或包含未知 item");
    }
    if (isTerminalRunStatus(local.status)) return local;

    const remoteById = new Map(remote.items.map((item) => [item.id, item]));
    const items = local.items.map((localItem) => {
      const remoteItem = remoteById.get(localItem.id);
      return {
        ...localItem,
        ...remoteItem,
        reason: mergedReason(localItem, remoteItem),
      };
    });
    return {
      ...local,
      ...remote,
      runId: local.runId,
      parentRunId: local.parentRunId,
      items,
    };
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
    parseBatchRun,
    isRetryableItemStatus,
    isTerminalRunStatus,
    retryableItems,
    intersectRetrySelection,
    retryRun,
    mergePollResult,
    getSyntheticRun,
  });
})(globalThis);
