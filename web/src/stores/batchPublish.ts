import { create } from "zustand";
import { buildBatchItemsFromMatrix, officialApi } from "../api/official";
import type { Platform } from "../api/types";
import type { BatchItem, BatchItemResult } from "../types/batch";
import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";

/**
 * 矩阵批量发布 store（issue #37 / #38 重写后形态）。
 *
 * 旧模型（#01 之前）：单一 title + 单一 tags + 一组账号 → 笛卡尔展开。
 * 新模型：每视频一条 BatchItem，独立 title/caption/tags/accountIdsByPlatform/mode。
 *
 * 旧组件 BatchPublishSection.tsx 在 #02 切换之前仍消费旧接口
 * （title/tags/selectedFiles/accountIdsByPlatform/submit/validate/reset）；
 * 适配层把这些旧调用同步到新模型（虚拟 item）。#02 切换时统一删除。
 *
 * Result 反馈：按 item 索引（filePath + cookieFile 稳定组合）聚合，
 * 不再用 Platform 作 key —— 矩阵模式下同平台多账号展开时旧实现会互相覆盖。
 */

/* ───────────────────────── 状态 & Action 接口 ───────────────────────── */

interface BatchPublishState {
  /* ── 新模型（issue #38 落地） ── */
  items: BatchItem[];
  /** 整批共用时刻池，'HH:MM' 字符串数组。 */
  dailyTimes: string[];
  submitting: boolean;
  /** 上次提交反馈；null = 未提交过。 */
  itemResults: BatchItemResult[] | null;
  /** 预览 Dialog 开关（#02 UI 接入；当前 store 已提供 action）。 */
  previewOpen: boolean;

  /* ── 新 actions ── */
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

  /* ── 旧接口适配层（#02 切换时统一删除） ── */
  title: string;
  tags: string;
  selectedFiles: string[];
  accountIdsByPlatform: Partial<Record<Platform, number[]>>;
  /**
   * 旧版总反馈（按平台聚合）。适配层同步自 itemResults：
   * itemResults -> 按 Platform 聚合（每 Platform 一条）写入 batchResult，
   * 旧组件读 batchResult 仍能渲染。#02 切换时连同旧 actions 一并删除。
   */
  batchResult: {
    total: number;
    okCount: number;
    items: Partial<Record<Platform, { ok: boolean; msg: string }>>;
  } | null;
  setForm: (patch: Partial<Pick<BatchPublishState, "title" | "tags">>) => void;
  setSelectedFiles: (files: string[]) => void;
  setPlatformAccountIds: (platform: Platform, ids: number[]) => void;
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
  | "setForm"
  | "setSelectedFiles"
  | "setPlatformAccountIds"
> = {
  items: [],
  dailyTimes: [],
  submitting: false,
  itemResults: null,
  previewOpen: false,

  // 旧接口字段（适配层用）
  title: "",
  tags: "",
  selectedFiles: [],
  accountIdsByPlatform: { douyin: [], xiaohongshu: [], wechat: [], kuaishou: [] },
  batchResult: null,
};

/* ───────────────────────── 适配层 helpers ───────────────────────── */

/**
 * 把新 itemResults 聚合为旧版 batchResult（按 Platform 一条）。
 * 矩阵模式下同一平台多账号 → 全部成功才记 ok=true，否则记 ok=false（保留最后一条错误 msg）。
 * 仅用于适配 BatchPublishSection.tsx 在 #02 切换前的旧渲染路径。
 */
function aggregateByPlatform(results: BatchItemResult[]): NonNullable<
  BatchPublishState["batchResult"]
> {
  const byPlatform: Partial<
    Record<Platform, { ok: boolean; msg: string }>
  > = {};
  let okCount = 0;
  for (const r of results) {
    const cur = byPlatform[r.platform];
    if (!cur) {
      byPlatform[r.platform] = { ok: r.ok, msg: r.msg };
    } else if (!r.ok) {
      // 任一失败覆盖到 Platform 粒度（透传最后一条 msg）
      byPlatform[r.platform] = { ok: false, msg: r.msg };
    }
  }
  for (const v of Object.values(byPlatform)) {
    if (v?.ok) okCount += 1;
  }
  return { total: Object.keys(byPlatform).length, okCount, items: byPlatform };
}

/**
 * 把旧接口的 selectedFiles + accountIdsByPlatform(id) + title + tags
 * 适配为新模型的 items 数组（每文件一个 item）。
 *
 * 仅在旧组件调用 setSelectedFiles / setPlatformAccountIds 时同步触发，
 * 保证旧组件的「单标题 + 单标签 + 多文件 × 多账号」语义仍能正确提交。
 */
function buildLegacyItems(args: {
  title: string;
  tags: string;
  selectedFiles: string[];
  accountIdsByPlatform: Partial<Record<Platform, number[]>>;
}): BatchItem[] {
  return args.selectedFiles.map((filePath) => {
    // 仅保留该视频被勾选的账号（其它账号的勾选由其它 item 表达？不，旧模型是「所有文件共用账号」）。
    // 旧模型语义：selectedFiles 共享一组 accountIdsByPlatform。
    // 这里把每个 filePath 复制同一份账号集合。
    return {
      filePath,
      title: args.title,
      caption: "",
      tags: args.tags,
      accountIdsByPlatform: {}, // 真实账号在 submit 时从 accounts store + accountIdsByPlatform 推导
      mode: "immediate" as const,
    };
  });
}

/** id → cookieFile 映射（缺失则空串，过滤掉）。 */
function mapIdsToCookieFiles(
  ids: number[],
): string[] {
  const accounts = useAccountsStore.getState().accounts;
  return ids
    .map((id) => accounts.find((a) => a.id === id)?.cookieFile ?? "")
    .filter(Boolean);
}

/* ───────────────────────── 校验 ───────────────────────── */

export function validateBatch(items: BatchItem[], dailyTimes: string[]): string[] {
  const errors: string[] = [];
  if (items.length === 0) errors.push("请至少添加一条视频");
  const dailyTimesSet = new Set(dailyTimes);
  items.forEach((item, idx) => {
    if (!item.title.trim()) errors.push(`第 ${idx + 1} 行：标题不能为空`);
    const hasAccount = (Object.values(item.accountIdsByPlatform) as string[][]).some(
      (a) => a && a.length > 0,
    );
    if (!hasAccount) errors.push(`第 ${idx + 1} 行：请至少选择一个平台的账号`);
    if (item.mode === "timer") {
      if (!item.timeOfDay || !dailyTimesSet.has(item.timeOfDay)) {
        errors.push(
          `第 ${idx + 1} 行：定时模式必须从顶部时刻表挑 1 个时刻（timeOfDay）`,
        );
      }
      if (item.startDays === undefined || item.startDays < 0) {
        errors.push(`第 ${idx + 1} 行：定时模式必须设置起始日 startDays >= 0`);
      }
    }
  });
  return errors;
}

/* ───────────────────────── store 实现 ───────────────────────── */

export const useBatchPublishStore = create<BatchPublishState>()((set, get) => ({
  ...initialBatchPublishState,

  /* ── 新 actions ── */

  addItem: (item) =>
    set((s) => ({ items: [...s.items, item] })),

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

  addDailyTime: (hm) =>
    set((s) => ({
      dailyTimes: s.dailyTimes.includes(hm) ? s.dailyTimes : [...s.dailyTimes, hm],
    })),

  removeDailyTime: (hm) =>
    set((s) => ({
      dailyTimes: s.dailyTimes.filter((t) => t !== hm),
      // 顺手清理被引用 item 的 timeOfDay（这些 item 引用了 dailyTimes 池中已删除项）
      items: s.items.map((i) =>
        i.timeOfDay === hm ? { ...i, timeOfDay: "" } : i,
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

    // 如果旧接口被用过（selectedFiles 非空），把旧字段适配为 items（虚拟）。
    // 新组件直接走 items 路径，items 已含 cookie 文件名。
    const itemsForBuild =
      s.items.length > 0
        ? s.items
        : buildLegacyItems({
            title: s.title,
            tags: s.tags,
            selectedFiles: s.selectedFiles,
            accountIdsByPlatform: s.accountIdsByPlatform,
          });

    // 把 items 中 cookie 文件名映射给 buildBatchItemsFromMatrix（它要 cookie 文件名）。
    // 旧路径下 legacyItems 的 accountIdsByPlatform 是空的；需要从旧 accountIdsByPlatform
    // 按 (platform, id) 推导 cookie 文件名。
    const itemsWithCookies: BatchItem[] = itemsForBuild.map((it) => {
      const accountIdsByPlatform: BatchItem["accountIdsByPlatform"] = {};
      // 1) 如果 items 中已经有 cookie 文件名（new UI 写入），直接用
      if (Object.keys(it.accountIdsByPlatform).length > 0) {
        return it;
      }
      // 2) legacy 路径：从旧 accountIdsByPlatform(id) 映射
      for (const [platform, ids] of Object.entries(s.accountIdsByPlatform) as [
        Platform,
        number[],
      ][]) {
        if (!ids || ids.length === 0) continue;
        accountIdsByPlatform[platform as Platform] = mapIdsToCookieFiles(ids);
      }
      // items 内部 filePath 与 selectedFiles 对应，accountIdsByPlatform 来自旧 store 全局共享
      return { ...it, accountIdsByPlatform };
    });

    const request = buildBatchItemsFromMatrix(itemsWithCookies, s.dailyTimes);
    const submittingResults: BatchItemResult[] = [];

    set({ submitting: true });
    try {
      await officialApi.postVideoBatch(base, request);
      // 成功：每请求项生成一条反馈
      for (const item of itemsWithCookies) {
        for (const [platform, cookies] of Object.entries(item.accountIdsByPlatform) as [
          Platform,
          string[],
        ][]) {
          for (const cookie of cookies) {
            submittingResults.push({
              itemKey: `${item.filePath}|${cookie}`,
              fileName: item.filePath,
              platform,
              mode: item.mode,
              timeOfDay: item.timeOfDay,
              startDays: item.startDays,
              ok: true,
              msg: "批量发布任务已提交",
            });
          }
        }
      }
      set({
        itemResults: submittingResults,
        batchResult: aggregateByPlatform(submittingResults),
      });
    } catch (e) {
      // 请求级错误：每项独立标识失败 + 透传 msg
      const msg = e instanceof Error ? e.message : String(e);
      for (const item of itemsWithCookies) {
        for (const [platform, cookies] of Object.entries(item.accountIdsByPlatform) as [
          Platform,
          string[],
        ][]) {
          for (const cookie of cookies) {
            submittingResults.push({
              itemKey: `${item.filePath}|${cookie}`,
              fileName: item.filePath,
              platform,
              mode: item.mode,
              timeOfDay: item.timeOfDay,
              startDays: item.startDays,
              ok: false,
              msg,
            });
          }
        }
      }
      set({
        itemResults: submittingResults,
        batchResult: aggregateByPlatform(submittingResults),
      });
      throw e;
    } finally {
      set({ submitting: false });
    }
  },

  reset: () =>
    set({
      ...initialBatchPublishState,
      // 保留 action 引用（zustand 在 spread initial 时会丢失 actions）
      // 实际上 zustand 的 create 返回的 store 在 reset 调用时，函数引用依然挂在 store 实例上
      // —— 这里只需要重置状态字段
    }),

  /* ── 旧接口适配层（#02 切换时统一删除） ── */

  setForm: (patch) => set(patch),

  setSelectedFiles: (files) =>
    set((s) => {
      // 同步 push 到 items（每文件一个 item），保证旧组件「多文件」语义可被新 store 表达。
      const existingPaths = new Set(s.items.map((i) => i.filePath));
      const newItems: BatchItem[] = files
        .filter((f) => !existingPaths.has(f))
        .map((filePath) => ({
          filePath,
          title: s.title,
          caption: "",
          tags: s.tags,
          accountIdsByPlatform: {},
          mode: "immediate",
        }));
      // 移除不再勾选的文件
      const keptItems = s.items.filter((i) => files.includes(i.filePath));
      // 用旧 title/tags 同步已存在 items 的 title/tags（旧组件可能会改 setForm 然后 setSelectedFiles）
      const syncedItems = keptItems.map((i) => ({
        ...i,
        title: s.title,
        tags: s.tags,
      }));
      return {
        selectedFiles: files,
        items: [...syncedItems, ...newItems],
      };
    }),

  setPlatformAccountIds: (platform, ids) =>
    set((s) => {
      const cookies = mapIdsToCookieFiles(ids);
      // 旧路径：把账号写到所有旧 items（每个 item 共享一份账号 —— 与旧组件语义对齐）
      const items = s.items.map((i) => ({
        ...i,
        accountIdsByPlatform: { ...i.accountIdsByPlatform, [platform]: cookies },
      }));
      return {
        accountIdsByPlatform: { ...s.accountIdsByPlatform, [platform]: ids },
        items,
      };
    }),
}));

// 仅在测试需要时导出适配层 helper（避免外部模块依赖）
export { buildLegacyItems, mapIdsToCookieFiles };