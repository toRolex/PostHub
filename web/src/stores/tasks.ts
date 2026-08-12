import { create } from "zustand";
import { api } from "../api/client";
import type { Platform, PlatformJob, TaskItem, TaskStatus } from "../api/types";
import { useDaemonStore } from "./daemon";

export interface TaskFilters {
  platform?: Platform | "";
  status?: TaskStatus | "";
  from?: string;
  to?: string;
}

interface TasksState {
  tasks: TaskItem[];
  filters: Required<TaskFilters>;
  loading: boolean;
  actionLoading: boolean;
  error: string;
  fetchTasks: (filters?: TaskFilters) => Promise<void>;
  setFilters: (partial: TaskFilters) => void;
  cancelTask: (taskId: number) => Promise<void>;
  retryJob: (jobId: number) => Promise<PlatformJob | null>;
  fetchTaskDetail: (taskId: number) => Promise<TaskItem | null>;
}

const EMPTY_FILTERS: Required<TaskFilters> = {
  platform: "",
  status: "",
  from: "",
  to: "",
};

function buildQuery(filters: Required<TaskFilters>): string {
  const params = new URLSearchParams();
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const initialTasksState = {
  tasks: [] as TaskItem[],
  filters: { ...EMPTY_FILTERS },
  loading: false,
  actionLoading: false,
  error: "",
};

export const useTasksStore = create<TasksState>()((set, get) => ({
  ...initialTasksState,

  /** 拉取任务列表（含各平台 job 明细），应用当前筛选。 */
  fetchTasks: async (filters) => {
    if (filters) {
      set({ filters: { ...EMPTY_FILTERS, ...filters } });
    }
    const current = get().filters;
    set({ loading: true });
    try {
      const body = await api.tasks(useDaemonStore.getState().url, buildQuery(current));
      set({ tasks: body.tasks ?? [], error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /** 更新筛选并重新拉取。 */
  setFilters: (partial) => {
    set((s) => ({ filters: { ...s.filters, ...partial } }));
    void get().fetchTasks();
  },

  /** 取消尚未发布的任务（pending job → failed），成功后刷新列表。 */
  cancelTask: async (taskId) => {
    set({ actionLoading: true });
    try {
      await api.cancelTask(useDaemonStore.getState().url, taskId);
      set({ error: "" });
      await get().fetchTasks();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ actionLoading: false });
    }
  },

  /** 失败任务手动重试（终态 → pending），成功后刷新列表。 */
  retryJob: async (jobId) => {
    set({ actionLoading: true });
    try {
      const body = await api.retryJob(useDaemonStore.getState().url, jobId);
      set({ error: "" });
      await get().fetchTasks();
      return body.job ?? null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ actionLoading: false });
    }
  },

  fetchTaskDetail: async (taskId) => {
    try {
      const item = await api.taskDetail(useDaemonStore.getState().url, taskId);
      set({ error: "" });
      return item;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },
}));
