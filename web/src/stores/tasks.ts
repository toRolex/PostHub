import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";
import type { Platform } from "./accounts";

export interface TaskRecord {
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
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformJobRecord {
  id: number;
  task_id: number;
  account_id: number;
  platform: Platform;
  status: string;
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

export interface TaskDetail {
  task: TaskRecord;
  jobs: PlatformJobRecord[];
}

/** 终态（可手动重试）：failed / manual / needs_relogin。 */
export const RETRYABLE_TERMINAL = ["failed", "manual", "needs_relogin"];

interface TasksState {
  tasks: TaskDetail[];
  loading: boolean;
  error: string;
}

export const useTasksStore = defineStore("tasks", {
  state: (): TasksState => ({
    tasks: [],
    loading: false,
    error: "",
  }),

  actions: {
    /** 请求守护进程 /tasks，拉取任务列表（含各平台 job 状态）。 */
    async fetchTasks(): Promise<void> {
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/tasks`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        this.tasks = (body.tasks ?? []) as TaskDetail[];
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 手动重试终态 job：POST /tasks/{taskId}/jobs/{jobId}/retry，成功后刷新列表。 */
    async retryJob(taskId: number, jobId: number): Promise<void> {
      const daemon = useDaemonStore();
      const res = await fetch(`${daemon.url}/tasks/${taskId}/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json();
      if (!res.ok) {
        this.error = body.error || `HTTP ${res.status}`;
        throw new Error(this.error);
      }
      this.error = "";
      await this.fetchTasks();
    },
  },
});
