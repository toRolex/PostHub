import { create } from "zustand";
import {
  officialApi,
  buildPostVideoRequest,
  existingRunIdFromError,
} from "../api/official";
import type { Account, Platform, PlatformFields } from "../api/types";
import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";
import { useRunStore } from "./runs";
import { withMutation } from "./_withMutation";
import { trimPlatformFields, validatePlatformFields } from "../domain/declarations";
import { parseTags } from "../domain/tags";
import { normalizeDailyTimes } from "../domain/time";

const EMPTY_ACCOUNTS: Partial<Record<Platform, number | null>> = {
  douyin: null,
  xiaohongshu: null,
  wechat: null,
  kuaishou: null,
};

/** localStorage 键：发布默认定时配置（「定时设置」页可编辑）。 */
export const TIMER_PREF_KEY = "posthub.timerPref";

export interface TimerPref {
  timerEnabled: boolean;
  videosPerDay: number;
  dailyTimes: string[];
  startDays: number;
}

const DEFAULT_TIMER_PREF: TimerPref = {
  timerEnabled: false,
  videosPerDay: 1,
  dailyTimes: ["10:00", "14:00", "20:00"],
  startDays: 0,
};

/** 读取持久化的默认定时配置；旧 number[] 在读取时迁移为 HH:MM string[]。 */
export function loadTimerPref(): TimerPref {
  try {
    const raw = localStorage.getItem(TIMER_PREF_KEY);
    if (!raw) return DEFAULT_TIMER_PREF;
    const parsed = JSON.parse(raw) as Partial<TimerPref>;
    const pref: TimerPref = {
      timerEnabled:
        typeof parsed.timerEnabled === "boolean"
          ? parsed.timerEnabled
          : DEFAULT_TIMER_PREF.timerEnabled,
      videosPerDay:
        typeof parsed.videosPerDay === "number"
          ? parsed.videosPerDay
          : DEFAULT_TIMER_PREF.videosPerDay,
      dailyTimes: normalizeDailyTimes(parsed.dailyTimes),
      startDays:
        typeof parsed.startDays === "number" ? parsed.startDays : DEFAULT_TIMER_PREF.startDays,
    };
    // 双读单写：旧格式或非规范 string[] 读入后立即落成唯一新格式。
    saveTimerPref(pref);
    return pref;
  } catch {
    return DEFAULT_TIMER_PREF;
  }
}

function saveTimerPref(pref: TimerPref): void {
  try {
    localStorage.setItem(TIMER_PREF_KEY, JSON.stringify(pref));
  } catch {
    // 持久化失败不阻断（localStorage 不可用等），仅当次内存态生效。
  }
}

const initialForm = (): PublishFormValues => {
  const pref = loadTimerPref();
  return {
    title: "",
    caption: "",
    tags: "",
    selectedPlatforms: [],
    accountByPlatform: { ...EMPTY_ACCOUNTS },
    selectedFile: null,
    timerEnabled: pref.timerEnabled,
    videosPerDay: pref.videosPerDay,
    dailyTimes: pref.dailyTimes,
    startDays: pref.startDays,
    platformFields: {},
  };
};

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
  /** 定时发布开关。 */
  timerEnabled: boolean;
  /** 定时：每日条数（videosPerDay，官方要求 1..len(dailyTimes)）。 */
  videosPerDay: number;
  /** 定时：每日时刻（dailyTimes，HH:MM 字符串数组，分钟保真）。 */
  dailyTimes: string[];
  /** 定时：起始天（startDays，0 = 明天起）。 */
  startDays: number;
  /** 内容声明按平台分键（issue #43）。空字段视为不覆盖账号默认。 */
  platformFields: PlatformFields;
}

interface PublishState extends PublishFormValues {
  submitting: boolean;
  /** 各平台受理结果（ok 表示请求已受理，不表示 item 已发布成功）。key = 平台。 */
  results: Partial<
    Record<Platform, { ok: boolean; msg: string; runId?: string; existingRunId?: string }>
  >;
  setForm: (patch: PublishPatch) => void;
  setPlatforms: (platforms: Platform[], accounts: Account[]) => void;
  /** 定时设置页：整体写入默认定时配置并持久化到 localStorage。 */
  setTimerPref: (pref: TimerPref) => void;
  /** 前端校验：返回错误消息列表（空 = 通过）。可选传入表单快照（默认读当前 state）。 */
  validate: (form?: Partial<PublishFormValues>) => string[];
  /** 提交：对每个已选平台各调一次官方 /postVideo，收集结果。 */
  submit: () => Promise<void>;
  reset: () => void;
}

type PublishStateFields = Omit<
  PublishState,
  "setForm" | "setPlatforms" | "validate" | "submit" | "reset" | "setTimerPref"
>;

export const initialPublishState: PublishStateFields = {
  ...initialForm(),
  submitting: false,
  results: {},
};

export const usePublishStore = create<PublishState>()((set, get) => ({
  ...initialPublishState,

  setForm: (patch) => {
    set(patch);
    // 定时相关字段变动时同步持久化（「定时设置」页 / 发布页都走这里）。
    const timerKeys: (keyof TimerPref)[] = [
      "timerEnabled",
      "videosPerDay",
      "dailyTimes",
      "startDays",
    ];
    if (timerKeys.some((k) => k in patch)) {
      const s = get();
      saveTimerPref({
        timerEnabled: s.timerEnabled,
        videosPerDay: s.videosPerDay,
        dailyTimes: normalizeDailyTimes(s.dailyTimes),
        startDays: s.startDays,
      });
    }
  },

  /** 定时设置页：整体写入默认定时配置并持久化。 */
  setTimerPref: (pref) => {
    const normalized: TimerPref = {
      ...pref,
      dailyTimes: normalizeDailyTimes(pref.dailyTimes),
    };
    set({
      timerEnabled: normalized.timerEnabled,
      videosPerDay: normalized.videosPerDay,
      dailyTimes: normalized.dailyTimes,
      startDays: normalized.startDays,
    });
    saveTimerPref(normalized);
  },

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
    const fieldError = validatePlatformFields(s.platformFields);
    if (fieldError) errors.push(fieldError);
    // 定时：仅启用时校验；时间值使用本地日内 HH:MM，不带时区。
    if (s.timerEnabled) {
      if (!Number.isInteger(s.videosPerDay) || s.videosPerDay <= 0) {
        errors.push("每日条数需为正整数");
      }
      let timeCount = 0;
      if (!Array.isArray(s.dailyTimes) || s.dailyTimes.length === 0) {
        errors.push("每日时刻不能为空");
      } else {
        try {
          timeCount = normalizeDailyTimes(s.dailyTimes).length;
        } catch {
          errors.push("每日时刻须为 HH:MM（小时 0-23，分钟 0-59）");
        }
      }
      if (s.videosPerDay > 0 && timeCount > 0 && s.videosPerDay > timeCount) {
        errors.push(`每日条数不能超过时刻数量（${timeCount}）`);
      }
      if (!Number.isInteger(s.startDays) || s.startDays < 0) {
        errors.push("起始天需为非负整数");
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

    await withMutation(
      set,
      async () => {
        for (const p of s.selectedPlatforms) {
          const accId = accounts[p];
          // 取该平台账号的 cookie 文件名（官方 accountList 语义：cookiesFile 下相对名）。
          const cookieFile =
            accountList.find((a) => a.id === accId && a.platform === p)?.cookieFile ?? "";
          // 仅传表单实际填了的平台子键（避免空对象被透传成覆盖账号默认）
          const trimmed = p === "kuaishou" ? undefined : trimPlatformFields(s.platformFields, p);
          try {
            const payload = buildPostVideoRequest({
              platform: p,
              files: s.selectedFile ? [s.selectedFile] : [],
              accounts: [cookieFile],
              title: s.title,
              caption: s.caption,
              tags,
              platformFields: trimmed,
              timer: {
                enableTimer: s.timerEnabled,
                videosPerDay: s.videosPerDay,
                dailyTimes: s.dailyTimes,
                startDays: s.startDays,
              },
            });
            if (!s.timerEnabled) {
              const accepted = await officialApi.acceptRun(base, payload);
              useRunStore.getState().rememberAcceptedRun(accepted);
              results[p] = {
                ok: true,
                msg: "已受理，后台执行中",
                runId: accepted.runId,
              };
            } else {
              await officialApi.postVideo(base, payload);
              results[p] = { ok: true, msg: "发布任务已提交" };
            }
          } catch (e) {
            const existingRunId = existingRunIdFromError(e);
            results[p] = existingRunId
              ? {
                  ok: false,
                  msg: `本次未受理：已有运行 ${existingRunId}`,
                  existingRunId,
                }
              : {
                  ok: false,
                  msg: e instanceof Error ? e.message : String(e),
                };
          }
        }
        set({ results });
      },
      {
        begin: { submitting: true },
        end: { submitting: false },
        // 平台级错误已逐条收敛进 results；外层异常不写 error、原样抛出。
        onError: () => undefined,
        rethrow: true,
      },
    );
  },

  reset: () => set({ ...initialPublishState }),
}));
