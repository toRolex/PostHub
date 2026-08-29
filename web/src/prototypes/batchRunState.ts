import "./batchRunContract.js";

export type ItemStatus = PrototypeItemStatus;
export type RunStatus = PrototypeRunStatus;
export type BatchRunItem = PrototypeBatchRunItem;
export type BatchRun = PrototypeBatchRun;

export const {
  isRetryableItemStatus,
  isTerminalRunStatus,
  retryableItems,
  intersectRetrySelection,
  retryRun,
  mergePollResult,
  getSyntheticRun,
} = globalThis.PostHubBatchRunContract;
