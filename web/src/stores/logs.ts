import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  task_id: number | null;
  job_id: number | null;
  level: LogLevel;
  source: string;
  message: string;
  created_at: string;
}

export interface LogFilters {
  level?: LogLevel | "";
  task_id?: number | "";
}

interface LogsState {
  logs: LogEntry[];
  filters: Required<LogFilters>;
  loading: boolean;
  error: string;
}

const EMPTY_FILTERS: Required<LogFilters> = {
  level: "",
  task_id: "",
};

function buildQuery(filters: LogFilters): string {
  const params = new URLSearchParams();
  if (filters.level) params.set("level", filters.level);
  if (filters.task_id) params.set("task_id", String(filters.task_id));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const useLogsStore = defineStore("logs", {
  state: (): LogsState => ({
    logs: [],
    filters: { ...EMPTY_FILTERS },
    loading: false,
    error: "",
  }),

  actions: {
    /** 拉取应用内日志（level / task_id 筛选）。 */
    async fetchLogs(filters?: LogFilters): Promise<void> {
      if (filters) {
        this.filters = { ...EMPTY_FILTERS, ...filters };
      }
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/logs${buildQuery(this.filters)}`);
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        this.logs = body.logs ?? [];
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 更新筛选并重新拉取。 */
    setFilters(partial: LogFilters): void {
      this.filters = { ...this.filters, ...partial };
      void this.fetchLogs();
    },
  },
});
