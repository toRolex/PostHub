import { create } from "zustand";
import { officialApi, buildPostVideoBatchRequest } from "../api/official";
import type { Platform } from "../api/types";
import { OFFICIAL_TYPE_PLATFORM } from "../api/types";
import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";
import { parseTags } from "./publish";

/**
 * 批量发布 store：多文件 × 多账号 → 官方 /postVideoBatch（契约级，一次提交）。
 * 与单视频 `publish.ts` 并存；本 store 只承载「批量」专属状态与提交逻辑，
 * 不改动共享发布表单字段。
 */

export interface BatchItemStatus {
  /** 该平台此项是否成功提交（官方返回 200）。 */
  ok: boolean;
  /** 官方错误消息（失败时透传。含请求级 400/500/网络错误）。 */
  msg: string;
}

export interface BatchPlanItem {
  platform: Platform;
  /** 该平台所选账号的 cookie 文件名（accountList 语义）。 */
  accounts: string[];
}

interface BatchPublishState {
  /** 批量标题（一个标题应用到全部所选文件/账号）。 */
  title: string;
  /** 标签（空格/逗号分隔输入，提交时拆成数组）。 */
  tags: string;
  /** 选中的素材 file_path（videoFile 磁盘名）。 */
  selectedFiles: string[];
  /** 按平台选中的账号 id（未选为空数组）。 */
  accountIdsByPlatform: Partial<Record<Platform, number[]>>;
  submitting: boolean;
  /** 总体反馈 + 各平台子项状态。batchResult 非空即上次提交反馈。 */
  batchResult: {
    total: number;
    okCount: number;
    items: Partial<Record<Platform, BatchItemStatus>>;
  } | null;
  setForm: (patch: Partial<Pick<BatchPublishState, "title" | "tags">>) => void;
  setSelectedFiles: (files: string[]) => void;
  setPlatformAccountIds: (platform: Platform, ids: number[]) => void;
  /** 前端校验：返回错误消息列表（空 = 通过）。 */
  validate: () => string[];
  /** 提交：一次 POST /postVideoBatch，请求体 = 各平台数组项。 */
  submit: () => Promise<void>;
  reset: () => void;
}

export const initialBatchPublishState = {
  title: "",
  tags: "",
  selectedFiles: [] as string[],
  accountIdsByPlatform: { douyin: [], xiaohongshu: [], wechat: [], kuaishou: [] } as Partial<
    Record<Platform, number[]>
  >,
  submitting: false,
  batchResult: null,
};

/** 前端校验：返回错误消息列表（空 = 通过）。 */
export function validateBatch(form: {
  title: string;
  selectedFiles: string[];
  accountIdsByPlatform: Partial<Record<Platform, number[]>>;
}): string[] {
  const errors: string[] = [];
  if (!form.title.trim()) errors.push("批量标题不能为空");
  if (form.selectedFiles.length === 0) errors.push("请至少选择一个视频素材");
  const platforms = (Object.keys(form.accountIdsByPlatform) as Platform[]).filter(
    (p) => (form.accountIdsByPlatform[p]?.length ?? 0) > 0,
  );
  if (platforms.length === 0) errors.push("请至少选择一个平台的账号");
  return errors;
}

export const useBatchPublishStore = create<BatchPublishState>()((set, get) => ({
  ...initialBatchPublishState,

  setForm: (patch) => set(patch),

  setSelectedFiles: (files) => set({ selectedFiles: files }),

  setPlatformAccountIds: (platform, ids) =>
    set((s) => ({
      accountIdsByPlatform: { ...s.accountIdsByPlatform, [platform]: ids },
    })),

  validate: () =>
    validateBatch({
      title: get().title,
      selectedFiles: get().selectedFiles,
      accountIdsByPlatform: get().accountIdsByPlatform,
    }),

  submit: async () => {
    const s = get();
    const errors = s.validate();
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    const base = useDaemonStore.getState().url;
    const accountList = useAccountsStore.getState().accounts;
    const tags = parseTags(s.tags);
    const request = buildPostVideoBatchRequest({
      files: s.selectedFiles,
      title: s.title,
      tags,
      platforms: (Object.keys(s.accountIdsByPlatform) as Platform[])
        .filter((p) => (s.accountIdsByPlatform[p]?.length ?? 0) > 0)
        .map((platform) => ({
          platform,
          accounts: (s.accountIdsByPlatform[platform] ?? [])
            .map((id) => accountList.find((a) => a.id === id)?.cookieFile ?? "")
            .filter(Boolean),
        })),
    });

    const items: NonNullable<BatchPublishState["batchResult"]>["items"] = {};
    set({ submitting: true });
    try {
      await officialApi.postVideoBatch(base, request);
      for (const item of request) {
        items[OFFICIAL_TYPE_PLATFORM[item.type]] = {
          ok: true,
          msg: "批量发布任务已提交",
        };
      }
      set({
        batchResult: { total: request.length, okCount: request.length, items },
      });
    } catch (e) {
      // 请求级错误（含无登录态 401/校验 4xx/网络错误）：各平台子项统一标识失败。
      const msg = e instanceof Error ? e.message : String(e);
      for (const item of request) {
        items[OFFICIAL_TYPE_PLATFORM[item.type]] = { ok: false, msg };
      }
      set({
        batchResult: { total: request.length, okCount: 0, items },
      });
      throw e;
    } finally {
      set({ submitting: false });
    }
  },

  reset: () => set({ ...initialBatchPublishState }),
}));
