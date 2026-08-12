import { create } from "zustand";
import { api } from "../api/client";
import type { LogEntry, LogLevel } from "../api/types";
import { useDaemonStore } from "./daemon";

export interface LogFilters {
  level?: LogLevel | "";
  task_id?: number | "";
}

interface LogsState {
  logs: LogEntry[];
  filters: Required<LogFilters>;
  loading: boolean;
  error: string;
  fetchLogs: (filters?: LogFilters) => Promise<void>;
  setFilters: (partial: LogFilters) => void;
}

const EMPTY_FILTERS: Required<LogFilters> = {
  level: "",
  task_id: "",
};

function buildQuery(filters: Required<LogFilters>): string {
  const params = new URLSearchParams();
  if (filters.level) params.set("level", filters.level);
  if (filters.task_id) params.set("task_id", String(filters.task_id));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const initialLogsState = {
  logs: [] as LogEntry[],
  filters: { ...EMPTY_FILTERS },
  loading: false,
  error: "",
};

export const useLogsStore = create<LogsState>()((set, get) => ({
  ...initialLogsState,

  fetchLogs: async (filters) => {
    if (filters) {
      set({ filters: { ...EMPTY_FILTERS, ...filters } });
    }
    set({ loading: true });
    try {
      const body = await api.logs(
        useDaemonStore.getState().url,
        buildQuery(get().filters),
      );
      set({ logs: body.logs ?? [], error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  setFilters: (partial) => {
    set((s) => ({ filters: { ...s.filters, ...partial } }));
    void get().fetchLogs();
  },
}));
