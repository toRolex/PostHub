import { create } from "zustand";
import { officialApi, buildPostVideoRequest } from "../api/official";
import type { Account, Platform } from "../api/types";
import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";

const EMPTY_ACCOUNTS: Partial<Record<Platform, number | null>> = {
  douyin: null,
  xiaohongshu: null,
  wechat: null,
  kuaishou: null,
};

const initialForm = (): PublishFormValues => ({
  title: "",
  caption: "",
  tags: "",
  selectedPlatforms: [],
  accountByPlatform: { ...EMPTY_ACCOUNTS },
  selectedFile: null,
});

/** 表单可写字段。 */
type PublishPatch = Partial<
  Omit<PublishState, "submitting" | "setForm" | "setPlatforms" | "reset" | "validate" | "submit">
>;

export interface PublishFormValues {
  title: string;
  /** 正文/描述。官方 /postVideo 无独立 desc 字段，由 buildPostVideoRequest 合入 title。 */
  caption: string;
  /** 标签（空格/逗号分隔输入，前端拆成数组）。 */
  tags: string;
  selectedPlatforms: Platform[];
  accountByPlatform: Partial<Record<Platform, number | null>>;
  /** 选中素材（来自文件页素材库的 file_path，即官方 videoFile 磁盘名）。 */
  selectedFile: string | null;
}

interface PublishState extends PublishFormValues {
  submitting: boolean;
  /** 各平台提交结果（成功 / 官方错误消息）。key = 平台。 */
  results: Partial<Record<Platform, { ok: boolean; msg: string }>>;
  setForm: (patch: PublishPatch) => void;
  setPlatforms: (platforms: Platform[], accounts: Account[]) => void;
  /** 前端校验：返回错误消息列表（空 = 通过）。可选传入表单快照（默认读当前 state）。 */
  validate: (form?: Partial<PublishFormValues>) => string[];
  /** 提交：对每个已选平台各调一次官方 /postVideo，收集结果。 */
  submit: () => Promise<void>;
  reset: () => void;
}

type PublishStateFields = Omit<
  PublishState,
  "setForm" | "setPlatforms" | "validate" | "submit" | "reset"
>;

export const initialPublishState: PublishStateFields = {
  ...initialForm(),
  submitting: false,
  results: {},
};

/** 标签输入 → 数组（去空、去 #）。 */
export function parseTags(raw: string): string[] {
  return raw
    .split(/[\s,，]+/)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter(Boolean);
}

export const usePublishStore = create<PublishState>()((set, get) => ({
  ...initialPublishState,

  setForm: (patch) => set(patch),

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

  /** 前端校验：返回错误消息列表（空 = 通过）。 */
  validate: (form?: Partial<PublishFormValues>): string[] => {
    const s = { ...get(), ...form } as PublishFormValues;
    const errors: string[] = [];
    if (!s.title.trim()) errors.push("标题不能为空");
    if (!s.selectedFile) errors.push("请选择视频素材");
    if (s.selectedPlatforms.length === 0) errors.push("至少选择一个发布平台");
    for (const p of s.selectedPlatforms) {
      if (s.accountByPlatform[p] == null) {
        errors.push(`请为平台「${p}」选择账号`);
        break;
      }
    }
    return errors;
  },

  /**
   * 提交：对每个已选平台各调一次官方 /postVideo（单平台单动作，type 唯一）。
   * 单视频：每次用同一视频素材。结果按平台收敛到 `results`（成功 / 官方错误透传）。
   */
  submit: async () => {
    const s = get();
    const errors = s.validate();
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    const base = useDaemonStore.getState().url;
    const accounts = s.accountByPlatform;
    const accountList = useAccountsStore.getState().accounts;
    const tags = parseTags(s.tags);
    const results: PublishState["results"] = {};

    set({ submitting: true });
    try {
      for (const p of s.selectedPlatforms) {
        const accId = accounts[p];
        // 取该平台账号的 cookie 文件名（官方 accountList 语义：cookiesFile 下相对名）。
        const cookieFile =
          accountList.find((a) => a.id === accId && a.platform === p)?.cookieFile ?? "";
        try {
          await officialApi.postVideo(
            base,
            buildPostVideoRequest({
              platform: p,
              files: s.selectedFile ? [s.selectedFile] : [],
              accounts: [cookieFile],
              title: s.title,
              caption: s.caption,
              tags,
            }),
          );
          results[p] = { ok: true, msg: "发布任务已提交" };
        } catch (e) {
          results[p] = {
            ok: false,
            msg: e instanceof Error ? e.message : String(e),
          };
        }
      }
      set({ results });
    } finally {
      set({ submitting: false });
    }
  },

  reset: () => set({ ...initialPublishState }),
}));
