import { create } from "zustand";
import {
  buildBatchItemsFromMatrix,
  confirmDuplicateRecords,
  duplicateRecordsFromError,
  existingRunIdFromError,
  officialApi,
} from "../api/official";
import type { PlatformFields } from "../api/types";
import { validateBatch, type BatchItem } from "../domain/batch";
import { useDaemonStore } from "./daemon";
import { useRunStore } from "./runs";
import { withMutation } from "./_withMutation";
import { normalizeHHMM } from "../domain/time";

/**
 * 矩阵批量发布 store。
 *
 * 模型：每视频一条 BatchItem，独立 title/caption/tags/accountCookiesByPlatform/mode；
 * 整批共用 dailyTimes 池；result 按 (filePath, cookieFile) 稳定组合反馈。
 */

interface BatchPublishState {
  items: BatchItem[];
  /** 整批共用时刻池，'HH:MM' 字符串数组。 */
  dailyTimes: string[];
  submitting: boolean;
  /** 预览 Dialog 开关。 */
  previewOpen: boolean;

  addItem: (item: BatchItem) => void;
  removeItem: (filePath: string) => void;
  updateItem: (filePath: string, patch: Partial<BatchItem>) => void;
  setItemMode: (filePath: string, mode: BatchItem["mode"]) => void;
  setItemTimeOfDay: (filePath: string, timeOfDay: string) => void;
  /** 设置单条 BatchItem 的某平台声明（issue #43）。 */
  setItemPlatformField: (
    filePath: string,
    platform: "wechat" | "douyin" | "xiaohongshu",
    value: PlatformFields["wechat"] | PlatformFields["douyin"] | PlatformFields["xiaohongshu"],
  ) => void;
  addDailyTime: (hm: string) => void;
  removeDailyTime: (hm: string) => void;
  openPreview: () => void;
  closePreview: () => void;
  /** 提交：校验通过后将完整矩阵一次 POST /postRuns 受理。 */
  submit: () => Promise<void>;
  reset: () => void;
  /** 前端校验：返回错误消息列表（空 = 通过）。 */
  validate: () => string[];
}

/* ───────────────────────── initial state ───────────────────────── */

export const initialBatchPublishState: Omit<
  BatchPublishState,
  | "addItem"
  | "removeItem"
  | "updateItem"
  | "setItemMode"
  | "setItemTimeOfDay"
  | "setItemPlatformField"
  | "addDailyTime"
  | "removeDailyTime"
  | "openPreview"
  | "closePreview"
  | "submit"
  | "reset"
  | "validate"
> = {
  items: [],
  dailyTimes: [],
  submitting: false,
  previewOpen: false,
};

/* ───────────────────────── helpers ───────────────────────── */

/* ───────────────────────── store 实现 ───────────────────────── */

async function acceptWithDuplicateConfirmation(
  base: string,
  payload: ReturnType<typeof buildBatchItemsFromMatrix>,
): Promise<Awaited<ReturnType<typeof officialApi.acceptRun>>> {
  try {
    return await officialApi.acceptRun(base, payload);
  } catch (error) {
    const duplicates = duplicateRecordsFromError(error);
    if (duplicates.length === 0 || !confirmDuplicateRecords(duplicates)) throw error;
    return officialApi.acceptRun(base, payload, { confirmDuplicates: true });
  }
}

export const useBatchPublishStore = create<BatchPublishState>()((set, get) => ({
  ...initialBatchPublishState,

  addItem: (item) =>
    set((s) =>
      s.items.some((existing) => existing.filePath === item.filePath)
        ? s
        : { items: [...s.items, item] },
    ),

  removeItem: (filePath) =>
    set((s) => ({ items: s.items.filter((i) => i.filePath !== filePath) })),

  updateItem: (filePath, patch) =>
    set((s) => ({
      items: s.items.map((i) => (i.filePath === filePath ? { ...i, ...patch } : i)),
    })),

  setItemMode: (filePath, mode) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.filePath === filePath
          ? {
              ...i,
              mode,
              // 切到 timer 时给个默认 startDays（0=明天起），timeOfDay 默认空让用户从 dailyTimes 挑
              startDays: mode === "timer" ? (i.startDays ?? 0) : undefined,
              timeOfDay: mode === "timer" ? (i.timeOfDay ?? "") : undefined,
            }
          : i,
      ),
    })),

  setItemTimeOfDay: (filePath, timeOfDay) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.filePath === filePath ? { ...i, timeOfDay } : i,
      ),
    })),

  setItemPlatformField: (filePath, platform, value) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.filePath === filePath
          ? { ...i, platformFields: { ...(i.platformFields ?? {}), [platform]: value } }
          : i,
      ),
    })),

  addDailyTime: (hm) => {
    let normalized: string;
    try {
      normalized = normalizeHHMM(hm);
    } catch {
      return;
    }
    set((s) => ({
      dailyTimes: s.dailyTimes.includes(normalized)
        ? s.dailyTimes
        : [...s.dailyTimes, normalized].sort(),
    }));
  },

  removeDailyTime: (hm) =>
    set((s) => ({
      dailyTimes: s.dailyTimes.filter((t) => t !== hm),
      // 顺手清理被引用 item 的 timeOfDay（这些 item 引用了 dailyTimes 池中已删除项）；
      // 设为 undefined 让 validateBatch 与 buildBatchItemsFromMatrix 的 timer 校验拒绝通过，
      // 避免非法提交。
      items: s.items.map((i) =>
        i.timeOfDay === hm ? { ...i, timeOfDay: undefined } : i,
      ),
    })),

  openPreview: () => set({ previewOpen: true }),
  closePreview: () => set({ previewOpen: false }),

  validate: () => {
    const s = get();
    return validateBatch(s.items, s.dailyTimes).map((e) =>
      e.row > 0 ? `第 ${e.row} 行：${e.msg}` : e.msg,
    );
  },

  submit: async () => {
    const s = get();
    const errors = s.validate();
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }
    const base = useDaemonStore.getState().url;

    const request = buildBatchItemsFromMatrix(s.items, s.dailyTimes);

    await withMutation(
      set,
      async () => {
        const accepted = await acceptWithDuplicateConfirmation(base, request);
        // accepted response 只更新 RunStore；item 状态必须来自后端 run snapshot，
        // 禁止在请求层合成成功/失败结果。
        useRunStore.getState().rememberAcceptedRun(accepted);
      },
      {
        begin: { submitting: true },
        end: { submitting: false },
        // 请求失败不改变任何 item 状态；只有后端 run snapshot 才能表达 item 事实。
        onError: (message, error) => {
          const existingRunId = existingRunIdFromError(error);
          useRunStore.setState({
            error: existingRunId
              ? `${message}（已有运行 ${existingRunId}）`
              : message,
          });
          return undefined;
        },
        rethrow: true,
      },
    );
  },

  reset: () => set({ ...initialBatchPublishState }),
}));
