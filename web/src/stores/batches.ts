import { create } from "zustand";
import { api } from "../api/client";
import type { ImportResult, ManifestEntry } from "../api/types";
import { useAccountsStore } from "./accounts";
import { useDaemonStore } from "./daemon";

interface BatchesState {
  /** 批次文件夹路径（含 manifest.json）。 */
  folderPath: string;
  /** 导入 UI 选定的目标账号（批次默认账号）。 */
  selectedAccountId: number | null;
  /** 解析结果：entries = 待确认列表；hard_errors 非空 = 整批拒绝。 */
  result: ImportResult | null;
  /** 逐条账号覆盖：entry index -> account_id。 */
  accountOverrides: Record<number, number>;
  parsing: boolean;
  confirming: boolean;
  error: string;
  lastTaskIds: number[];
  setFolderPath: (p: string) => void;
  setSelectedAccountId: (id: number | null) => void;
  parse: () => Promise<ImportResult>;
  patchEntry: (index: number, patch: Partial<ManifestEntry>) => void;
  setEntryAccount: (index: number, accountId: number) => void;
  confirm: () => Promise<number[]>;
  reset: () => void;
}

export const initialBatchesState = {
  folderPath: "",
  selectedAccountId: null as number | null,
  result: null as ImportResult | null,
  accountOverrides: {} as Record<number, number>,
  parsing: false,
  confirming: false,
  error: "",
  lastTaskIds: [] as number[],
};

export const useBatchesStore = create<BatchesState>()((set, get) => ({
  ...initialBatchesState,

  setFolderPath: (p) => set({ folderPath: p }),
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),

  /**
   * 解析批次：POST /batches/import（folder_path + account_id）。
   * 返回结构化结果；hard_errors 非空时前端明确展示（整批拒绝）。
   */
  parse: async () => {
    const s = get();
    if (!s.folderPath.trim()) {
      throw new Error("请选择批次文件夹（含 manifest.json）");
    }
    if (s.selectedAccountId == null) {
      throw new Error("请选择目标账号");
    }
    set({ parsing: true });
    try {
      const result = await api.batchImport(useDaemonStore.getState().url, {
        folder_path: s.folderPath,
        account_id: s.selectedAccountId,
      });
      set({ result, accountOverrides: {}, error: "" });
      return result;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ parsing: false });
    }
  },

  /** 逐条覆盖：更新待确认列表某条目的字段（标题/正文/封面/定时）。 */
  patchEntry: (index, patch) => {
    const r = get().result;
    if (!r) return;
    set({
      result: {
        ...r,
        entries: r.entries.map((e) =>
          e.index === index ? { ...e, ...patch } : e,
        ),
      },
    });
  },

  /** 逐条覆盖账号（及其所属平台）。 */
  setEntryAccount: (index, accountId) => {
    const s = get();
    if (!s.result) return;
    if (s.selectedAccountId === accountId) {
      const next = { ...s.accountOverrides };
      delete next[index];
      set({ accountOverrides: next });
    } else {
      set({ accountOverrides: { ...s.accountOverrides, [index]: accountId } });
    }
  },

  /**
   * 确认放行：POST /batches/confirm，逐条走 create_task 同一发布通道。
   * 每条携带最终账号/平台（批次默认 + 逐条覆盖）；返回生成的 task id 列表。
   */
  confirm: async () => {
    const s = get();
    if (!s.result) {
      throw new Error("请先解析批次");
    }
    if (s.selectedAccountId == null) {
      throw new Error("请选择目标账号");
    }
    const accounts = useAccountsStore.getState().accounts;
    const entries = s.result.entries.map((e) => {
      const accId = s.accountOverrides[e.index] ?? s.selectedAccountId!;
      const acc = accounts.find((a) => a.id === accId);
      return {
        file: e.file,
        title: e.title,
        content: e.content,
        tags: e.tags,
        cover_landscape: e.cover_landscape,
        cover_portrait: e.cover_portrait,
        schedule: e.schedule,
        account_id: accId,
        platform: acc ? acc.platform : undefined,
      };
    });

    set({ confirming: true });
    try {
      const body = await api.batchConfirm(useDaemonStore.getState().url, {
        account_id: s.selectedAccountId,
        entries,
      });
      const lastTaskIds = body.task_ids ?? [];
      set({ lastTaskIds, error: "" });
      return lastTaskIds;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ confirming: false });
    }
  },

  reset: () =>
    set({
      folderPath: "",
      selectedAccountId: null,
      result: null,
      accountOverrides: {},
      parsing: false,
      confirming: false,
      error: "",
      lastTaskIds: [],
    }),
}));
