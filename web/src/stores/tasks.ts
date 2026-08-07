import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";

export type Platform = "douyin" | "xiaohongshu" | "wechat";
export type JobStatus =
  | "pending"
  | "publishing"
  | "success"
  | "failed"
  | "manual"
  | "needs_relogin"
  | "missed";
export type TaskStatus = JobStatus | "partial";

export interface Task {
  id: number;
  title: string;
  media_type: string;
  video_path: string | null;
  image_paths: string | null;
  caption: string | null;
  tags: string | null;
  cover_horizontal: string | null;
  cover_vertical: string | null;
  schedule_policy: string;
  publish_mode: string;
  publish_at: string | null;
  silent: number;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface PlatformJob {
  id: number;
  task_id: number;
  account_id: number;
  platform: Platform;
  status: JobStatus;
  schedule_policy: string | null;
  publish_mode: string | null;
  publish_at: string | null;
  retry_at: string | null;
  title: string | null;
  caption: string | null;
  tags: string | null;
  cover_horizontal: string | null;
  cover_vertical: string | null;
  platform_fields: string | null;
  post_id: string | null;
  post_url: string | null;
  attempt_count: number;
  last_error: string | null;
  last_error_type: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskItem {
  task: Task;
  jobs: PlatformJob[];
}

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
}

const EMPTY_FILTERS: Required<TaskFilters> = {
  platform: "",
  status: "",
  from: "",
  to: "",
};

function buildQuery(filters: TaskFilters): string {
  const params = new URLSearchParams();
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const useTasksStore = defineStore("tasks", {
  state: (): TasksState => ({
    tasks: [],
    filters: { ...EMPTY_FILTERS },
    loading: false,
    actionLoading: false,
    error: "",
  }),

  actions: {
    /** 拉取任务列表（含各平台 job 明细），应用当前筛选。 */
    async fetchTasks(filters?: TaskFilters): Promise<void> {
      if (filters) {
        this.filters = { ...EMPTY_FILTERS, ...filters };
      }
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/tasks${buildQuery(this.filters)}`);
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        this.tasks = body.tasks ?? [];
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 更新筛选并重新拉取。 */
    setFilters(partial: TaskFilters): void {
      this.filters = { ...this.filters, ...partial };
      void this.fetchTasks();
    },

    /** 取消尚未发布的任务（pending job → failed），成功后刷新列表。 */
    async cancelTask(taskId: number): Promise<void> {
      const daemon = useDaemonStore();
      this.actionLoading = true;
      try {
        const res = await fetch(`${daemon.url}/tasks/${taskId}/cancel`, {
          method: "POST",
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        this.error = "";
        await this.fetchTasks();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.actionLoading = false;
      }
    },

    /** 失败任务手动重试（终态 → pending），成功后刷新列表。 */
    async retryJob(jobId: number): Promise<PlatformJob | null> {
      const daemon = useDaemonStore();
      this.actionLoading = true;
      try {
        const res = await fetch(`${daemon.url}/jobs/${jobId}/retry`, {
          method: "POST",
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        this.error = "";
        await this.fetchTasks();
        return (body.job as PlatformJob) ?? null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.actionLoading = false;
      }
    },

    /** 拉取单任务明细。 */
    async fetchTaskDetail(taskId: number): Promise<TaskItem | null> {
      const daemon = useDaemonStore();
      try {
        const res = await fetch(`${daemon.url}/tasks/${taskId}`);
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        this.error = "";
        return body as TaskItem;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return null;
      }
    },
  },
});
