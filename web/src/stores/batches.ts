import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";
import { useAccountsStore } from "./accounts";

export interface ManifestIssue {
  index: number | null;
  message: string;
}

export interface ManifestEntry {
  index: number;
  file: string;
  title: string;
  content: string | null;
  tags: string[];
  cover_landscape: string | null;
  cover_portrait: string | null;
  schedule: string | null;
  warnings: string[];
}

export interface ImportResult {
  version: number;
  entries: ManifestEntry[];
  hard_errors: ManifestIssue[];
}

interface BatchState {
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
}

export const useBatchesStore = defineStore("batches", {
  state: (): BatchState => ({
    folderPath: "",
    selectedAccountId: null,
    result: null,
    accountOverrides: {},
    parsing: false,
    confirming: false,
    error: "",
    lastTaskIds: [],
  }),

  getters: {
    hasHardErrors: (state) => (state.result?.hard_errors.length ?? 0) > 0,
    pendingEntries: (state) => state.result?.entries ?? [],
  },

  actions: {
    /**
     * 解析批次：POST /batches/import（folder_path + account_id）。
     * 返回结构化结果；hard_errors 非空时前端明确展示（整批拒绝）。
     */
    async parse(): Promise<ImportResult> {
      const daemon = useDaemonStore();
      if (!this.folderPath.trim()) {
        throw new Error("请选择批次文件夹（含 manifest.json）");
      }
      if (this.selectedAccountId == null) {
        throw new Error("请选择目标账号");
      }
      this.parsing = true;
      try {
        const res = await fetch(`${daemon.url}/batches/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder_path: this.folderPath,
            account_id: this.selectedAccountId,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        this.result = body as ImportResult;
        this.accountOverrides = {};
        this.error = "";
        return this.result;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.parsing = false;
      }
    },

    /** 逐条覆盖：更新待确认列表某条目的字段（标题/正文/封面/定时）。 */
    patchEntry(index: number, patch: Partial<ManifestEntry>): void {
      if (!this.result) return;
      const entries = this.result.entries.map((e) =>
        e.index === index ? { ...e, ...patch } : e,
      );
      this.result = { ...this.result, entries };
    },

    /** 逐条覆盖账号（及其所属平台）。 */
    setEntryAccount(index: number, accountId: number): void {
      if (!this.result) return;
      if (this.selectedAccountId === accountId) {
        const next = { ...this.accountOverrides };
        delete next[index];
        this.accountOverrides = next;
      } else {
        this.accountOverrides = { ...this.accountOverrides, [index]: accountId };
      }
    },

    /**
     * 确认放行：POST /batches/confirm，逐条走 create_task 同一发布通道。
     * 每条携带最终账号/平台（批次默认 + 逐条覆盖）；返回生成的 task id 列表。
     */
    async confirm(): Promise<number[]> {
      const daemon = useDaemonStore();
      const accounts = useAccountsStore();
      if (!this.result) {
        throw new Error("请先解析批次");
      }
      if (this.selectedAccountId == null) {
        throw new Error("请选择目标账号");
      }
      const entries = this.result.entries.map((e) => {
        const accId = this.accountOverrides[e.index] ?? this.selectedAccountId!;
        const acc = accounts.accounts.find((a) => a.id === accId);
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

      this.confirming = true;
      try {
        const res = await fetch(`${daemon.url}/batches/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: this.selectedAccountId, entries }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        this.lastTaskIds = body.task_ids ?? [];
        this.error = "";
        return this.lastTaskIds;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.confirming = false;
      }
    },

    reset(): void {
      this.$reset();
    },
  },
});
