import { create } from "zustand";
import {
  buildBatchItemsFromMatrix,
  existingRunIdFromError,
  officialApi,
} from "../api/official";
import type { PlatformFields } from "../api/types";
import {
  buildBatchItemRefs,
  keyOf,
  validateBatch,
  type BatchItem,
  type BatchItemResult,
} from "../domain/batch";
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
  /** 上次提交反馈；null = 未提交过。 */
  itemResults: BatchItemResult[] | null;
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
  /** 提交：校验通过后调 buildBatchItemsFromMatrix，一次 POST /postVideoBatch。 */
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
  itemResults: null,
  previewOpen: false,
};

/* ───────────────────────── helpers ───────────────────────── */

/**
 * 把 items × 平台 × 账号展开为 itemResults（每 (item, platform, account) 一条）。
 * 用于 submit 的成功 / 失败两个分支。
 */
function expandItemResults(
  items: BatchItem[],
  ok: boolean,
  msg: string,
): BatchItemResult[] {
  return buildBatchItemRefs(items).map(({ item, platform, cookie }) => ({
    itemKey: keyOf(item.filePath, cookie),
    fileName: item.filePath,
    platform,
    accountCookie: cookie,
    mode: item.mode,
    timeOfDay: item.timeOfDay,
    startDays: item.startDays,
    ok,
    msg,
  }));
}

/* ───────────────────────── store 实现 ───────────────────────── */

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
        if (s.items.every((item) => item.mode === "immediate")) {
          const accepted = await officialApi.acceptRun(base, request);
          useRunStore.getState().rememberAcceptedRun(accepted);
          const itemResults = expandItemResults(s.items, true, "已受理，后台执行中");
          set({ itemResults });
          return;
        }
        await officialApi.postVideoBatch(base, request);
        const itemResults = expandItemResults(s.items, true, "批量发布任务已提交");
        set({ itemResults });
      },
      {
        begin: { submitting: true },
        end: { submitting: false },
        // 请求级错误：每项独立标识失败；409 明确本次未受理并保留已有 run。
        onError: (message, error) => {
          const existingRunId = existingRunIdFromError(error);
          return {
            itemResults: existingRunId
              ? expandItemResults(
                  s.items,
                  false,
                  `本次未受理：已有运行 ${existingRunId}`,
                ).map((item) => ({ ...item, existingRunId }))
              : expandItemResults(s.items, false, message),
          };
        },
        rethrow: true,
      },
    );
  },

  reset: () => set({ ...initialBatchPublishState }),
}));
