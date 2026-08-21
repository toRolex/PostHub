import { create } from "zustand";
import { buildBatchItemsFromMatrix, officialApi } from "../api/official";
import type { Platform } from "../api/types";
import type { BatchItem, BatchItemResult } from "../types/batch";
import { useDaemonStore } from "./daemon";

/**
 * 矩阵批量发布 store。
 *
 * 模型：每视频一条 BatchItem，独立 title/caption/tags/accountIdsByPlatform/mode；
 * 整批共用 dailyTimes 池；result 按 (filePath, cookieFile) 稳定组合反馈。
 */

/**
 * 视频号单账号累计定时任务计数（issue #40）。
 *
 * 统计 `mode='timer'` 且 `accountIdsByPlatform.wechat` 包含该 cookieFile 的 item 数。
 * 每个 item 只计一次（不重复——同一 item 多账号展开不被累加）。本批次内累计；跨批次
 * 历史由官方兜底。
 */
export function selectWechatScheduledCount(items: BatchItem[], accountId: string): number {
  let count = 0;
  for (const item of items) {
    if (item.mode !== "timer") continue;
    const wechatCookies = item.accountIdsByPlatform.wechat ?? [];
    if (wechatCookies.includes(accountId)) count += 1;
  }
  return count;
}

/**
 * 视频号各账号本批次累计定时任务计数（cookieFile → count，issue #40）。
 *
 * 与 selectWechatScheduledCount 同一口径，一次遍历产出全账号 Map，
 * 供 UI（列表行 / 预览 Dialog）按 cookieFile O(1) 读取，避免渲染期逐账号重算。
 */
export function selectWechatScheduledCountsByAccount(
  items: BatchItem[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    if (item.mode !== "timer") continue;
    for (const cookieFile of item.accountIdsByPlatform.wechat ?? []) {
      map.set(cookieFile, (map.get(cookieFile) ?? 0) + 1);
    }
  }
  return map;
}

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

/* ───────────────────────── 校验 ───────────────────────── */

/** 单 item 校验分支（validateBatch / validateByFilePath 共用，避免双份逻辑漂移）。 */
function validateItemErrors(item: BatchItem, dailyTimesSet: Set<string>): string[] {
  const errors: string[] = [];
  if (!item.title.trim()) errors.push("标题不能为空");
  const hasAccount = (Object.values(item.accountIdsByPlatform) as string[][]).some(
    (a) => a && a.length > 0,
  );
  if (!hasAccount) errors.push("请至少选择一个平台的账号");
  if (item.mode === "timer") {
    if (!item.timeOfDay || !dailyTimesSet.has(item.timeOfDay)) {
      errors.push("定时模式必须从顶部时刻表挑 1 个时刻（timeOfDay）");
    }
    if (item.startDays === undefined || item.startDays < 0) {
      errors.push("定时模式必须设置起始日 startDays >= 0");
    }
  }
  return errors;
}

export function validateBatch(items: BatchItem[], dailyTimes: string[]): string[] {
  const errors: string[] = [];
  if (items.length === 0) errors.push("请至少添加一条视频");
  const dailyTimesSet = new Set(dailyTimes);
  items.forEach((item, idx) => {
    for (const e of validateItemErrors(item, dailyTimesSet)) {
      errors.push(`第 ${idx + 1} 行：${e}`);
    }
  });
  return errors;
}

/**
 * 按 filePath 分组的校验错误（filePath → 错误列表），仅含非法 item。
 * 与 validateBatch 共用校验分支；UI 行内错误与提交按钮 disabled 都读这份 Map，
 * 避免组件侧再算一遍。
 */
export function validateByFilePath(
  items: BatchItem[],
  dailyTimes: string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const dailyTimesSet = new Set(dailyTimes);
  for (const item of items) {
    const errors = validateItemErrors(item, dailyTimesSet);
    if (errors.length > 0) map.set(item.filePath, errors);
  }
  return map;
}

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
  const out: BatchItemResult[] = [];
  for (const item of items) {
    for (const [platform, cookies] of Object.entries(item.accountIdsByPlatform) as [
      Platform,
      string[],
    ][]) {
      for (const cookie of cookies) {
        out.push({
          itemKey: `${item.filePath}|${cookie}`,
          fileName: item.filePath,
          cookieFile: cookie,
          platform,
          mode: item.mode,
          timeOfDay: item.timeOfDay,
          startDays: item.startDays,
          ok,
          msg,
        });
      }
    }
  }
  return out;
}

/* ───────────────────────── store 实现 ───────────────────────── */

export const useBatchPublishStore = create<BatchPublishState>()((set, get) => ({
  ...initialBatchPublishState,

  addItem: (item) =>
    set((s) => ({ items: [...s.items, item] })),

  removeItem: (filePath) =>
    set((s) => ({ items: s.items.filter((i) => i.filePath !== filePath) })),

  updateItem: (filePath, patch) =>
    set((s) => ({
      items: s.items.map((i) => {
        if (i.filePath !== filePath) return i;
        // startDays 非负整数 clamp 的唯一入口（spec：startDays >= 0）；UI 不再各自兜底。
        const startDays =
          patch.startDays !== undefined
            ? Math.max(0, Number(patch.startDays) || 0)
            : i.startDays;
        return { ...i, ...patch, startDays };
      }),
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

  addDailyTime: (hm) =>
    set((s) => ({
      dailyTimes: s.dailyTimes.includes(hm) ? s.dailyTimes : [...s.dailyTimes, hm],
    })),

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
    return validateBatch(s.items, s.dailyTimes);
  },

  submit: async () => {
    const s = get();
    const errors = s.validate();
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }
    const base = useDaemonStore.getState().url;

    const request = buildBatchItemsFromMatrix(s.items, s.dailyTimes);

    set({ submitting: true });
    try {
      await officialApi.postVideoBatch(base, request);
      const itemResults = expandItemResults(s.items, true, "批量发布任务已提交");
      set({ itemResults });
    } catch (e) {
      // 请求级错误：每项独立标识失败 + 透传 msg
      const msg = e instanceof Error ? e.message : String(e);
      const itemResults = expandItemResults(s.items, false, msg);
      set({ itemResults });
      throw e;
    } finally {
      set({ submitting: false });
    }
  },

  reset: () => set({ ...initialBatchPublishState }),
}));