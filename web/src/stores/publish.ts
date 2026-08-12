import { create } from "zustand";
import { api } from "../api/client";
import type {
  Account,
  CreateTaskPayload,
  Platform,
  PublishMode,
  TaskResult,
} from "../api/types";
import { useDaemonStore } from "./daemon";
import { usePlatformStore } from "./platform";
import {
  formatDateTime,
  validatePublishForm,
  type PublishFormValues,
} from "../lib/publishValidation";

const EMPTY_ACCOUNTS: Partial<Record<Platform, number | null>> = {
  douyin: null,
  xiaohongshu: null,
  wechat: null,
};

const initialForm = (): PublishFormValues => ({
  title: "",
  videoPath: "",
  caption: "",
  coverMode: "auto",
  coverHorizontal: "",
  coverVertical: "",
  selectedPlatforms: [],
  accountByPlatform: { ...EMPTY_ACCOUNTS },
  schedulePolicy: "immediate",
  publishAt: null,
});

/** 表单可写字段：PublishFormValues + 排期/静默等扩展字段。 */
type PublishPatch = Partial<
  Omit<
    PublishState,
    "submitting" | "error" | "setForm" | "setPlatforms" | "setPublishAt" | "createTask" | "reset"
  >
>;

interface PublishState extends PublishFormValues {
  publishMode: PublishMode;
  silent: boolean;
  submitting: boolean;
  error: string;
  setForm: (patch: PublishPatch) => void;
  setPlatforms: (platforms: Platform[], accounts: Account[]) => void;
  setPublishAt: (date: Date | null) => void;
  createTask: () => Promise<TaskResult>;
  reset: () => void;
}

type PublishStateFields = Omit<
  PublishState,
  "setForm" | "setPlatforms" | "setPublishAt" | "createTask" | "reset"
>;

/** 初始状态（不含 action），供测试重置单例。 */
export const initialPublishState: PublishStateFields = {
  ...initialForm(),
  publishMode: "platform_time",
  silent: false,
  submitting: false,
  error: "",
};

export const usePublishStore = create<PublishState>()((set, get) => ({
  ...initialPublishState,

  setForm: (patch) => set(patch),

  /**
   * 勾选/取消平台：更新 selectedPlatforms，并为新选中的平台自动填充
   * 默认账号（该平台第一个账号）；取消的平台账号置空。
   */
  setPlatforms: (platforms, accounts) => {
    const accountByPlatform = { ...get().accountByPlatform };
    const selected = new Set(platforms);
    for (const p of Object.keys(accountByPlatform) as Platform[]) {
      if (!selected.has(p)) {
        accountByPlatform[p] = null;
      }
    }
    for (const p of platforms) {
      if (accountByPlatform[p] == null) {
        const match = accounts.find((a) => a.platform === p);
        accountByPlatform[p] = match ? match.id : null;
      }
    }
    set({ selectedPlatforms: platforms, accountByPlatform });
  },

  /** 把日期选择器的 Date 转成后端约定的本地时间字符串。 */
  setPublishAt: (date) => set({ publishAt: date ? formatDateTime(date) : null }),

  /** 提交任务：前端校验拦截非法输入，通过后 POST /tasks 落库。 */
  createTask: async () => {
    const s = get();
    const constraints = usePlatformStore.getState().constraints;
    const errors = validatePublishForm(
      {
        title: s.title,
        videoPath: s.videoPath,
        caption: s.caption,
        coverMode: s.coverMode,
        coverHorizontal: s.coverHorizontal,
        coverVertical: s.coverVertical,
        selectedPlatforms: s.selectedPlatforms,
        accountByPlatform: s.accountByPlatform,
        schedulePolicy: s.schedulePolicy,
        publishAt: s.publishAt,
      },
      constraints,
    );
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    set({ submitting: true });
    try {
      const jobs = s.selectedPlatforms
        .map((p) => ({ platform: p, account_id: s.accountByPlatform[p] as number }))
        .filter((j) => j.account_id != null);
      const payload: CreateTaskPayload = {
        title: s.title,
        video_path: s.videoPath,
        caption: s.caption,
        tags: [],
        cover_horizontal: s.coverMode === "file" ? s.coverHorizontal || null : null,
        cover_vertical: s.coverMode === "file" ? s.coverVertical || null : null,
        schedule_policy: s.schedulePolicy,
        publish_mode: s.publishMode,
        publish_at: s.schedulePolicy === "scheduled" ? s.publishAt : null,
        silent: s.silent,
        jobs,
      };
      const result = await api.createTask(useDaemonStore.getState().url, payload);
      set({ error: "" });
      return result;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ submitting: false });
    }
  },

  reset: () => set({ ...initialPublishState }),
}));
