export {};

declare global {
  type PrototypeItemStatus =
    | "pending"
    | "running"
    | "success"
    | "failure"
    | "skipped"
    | "interrupted"
    | "invalid";

  type PrototypeRunStatus =
    | "running"
    | "completed"
    | "completed_with_failures"
    | "interrupted"
    | "invalid";

  type PrototypeBatchRunItem = {
    id: string;
    file: string;
    platform: "douyin" | "xiaohongshu" | "wechat";
    account: string;
    status: PrototypeItemStatus;
    reason?: string;
    scheduled: string;
    retriedFrom?: string;
  };

  type PrototypeBatchRun = {
    runId: string;
    parentRunId?: string;
    status: PrototypeRunStatus;
    items: PrototypeBatchRunItem[];
    error?: string;
  };

  type PrototypeBatchRunParseResult =
    | { ok: true; value: PrototypeBatchRun }
    | { ok: false; error: string };

  var PostHubBatchRunContract: {
    parseBatchRun(candidate: unknown): PrototypeBatchRunParseResult;
    isRetryableItemStatus(status: PrototypeItemStatus): boolean;
    isTerminalRunStatus(status: PrototypeRunStatus): boolean;
    retryableItems(items: readonly PrototypeBatchRunItem[]): PrototypeBatchRunItem[];
    intersectRetrySelection(
      selected: readonly string[],
      items: readonly PrototypeBatchRunItem[],
    ): string[];
    retryRun(
      parent: PrototypeBatchRun,
      newRunId: string,
      requestedItemIds?: readonly string[],
    ): PrototypeBatchRun;
    mergePollResult(
      local: PrototypeBatchRun,
      remote: unknown,
    ): PrototypeBatchRun;
    getSyntheticRun(runId: string): PrototypeBatchRun;
  };
}
