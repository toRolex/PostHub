import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";
import { usePlatformStore, type Platform } from "./platform";
import {
  formatDateTime,
  validatePublishForm,
  type PublishFormValues,
} from "../lib/publishValidation";
import type { Account } from "./accounts";

export interface TaskResult {
  task: Record<string, unknown> & { id: number };
  jobs: (Record<string, unknown> & { id: number; platform: Platform })[];
}

interface PublishState extends PublishFormValues {
  publishMode: "platform_time" | "local_time";
  silent: boolean;
  submitting: boolean;
  error: string;
}

const EMPTY_ACCOUNTS: Partial<Record<Platform, number | null>> = {
  douyin: null,
  xiaohongshu: null,
  wechat: null,
};

export const usePublishStore = defineStore("publish", {
  state: (): PublishState => ({
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
    publishMode: "platform_time",
    silent: false,
    submitting: false,
    error: "",
  }),

  getters: {
    /** 按所选平台动态拼装校验错误（引用平台约束注册表）。 */
    validationErrors(state): string[] {
      const constraints = usePlatformStore().constraints;
      return validatePublishForm(
        {
          title: state.title,
          videoPath: state.videoPath,
          caption: state.caption,
          coverMode: state.coverMode,
          coverHorizontal: state.coverHorizontal,
          coverVertical: state.coverVertical,
          selectedPlatforms: state.selectedPlatforms,
          accountByPlatform: state.accountByPlatform,
          schedulePolicy: state.schedulePolicy,
          publishAt: state.publishAt,
        },
        constraints,
      );
    },
  },

  actions: {
    /**
     * 勾选/取消平台：更新 selectedPlatforms，并为新选中的平台自动填充
     * 默认账号（该平台第一个账号）；取消的平台账号置空。
     */
    setPlatforms(platforms: Platform[], accounts: Account[]): void {
      this.selectedPlatforms = platforms;
      const selected = new Set(platforms);
      for (const p of Object.keys(this.accountByPlatform) as Platform[]) {
        if (!selected.has(p)) {
          this.accountByPlatform[p] = null;
        }
      }
      for (const p of platforms) {
        if (this.accountByPlatform[p] == null) {
          const match = accounts.find((a) => a.platform === p);
          this.accountByPlatform[p] = match ? match.id : null;
        }
      }
    },

    /** 提交任务：前端校验拦截非法输入，通过后 POST /tasks 落库。 */
    async createTask(): Promise<TaskResult> {
      const errors = this.validationErrors;
      if (errors.length > 0) {
        throw new Error(errors.join("；"));
      }

      const daemon = useDaemonStore();
      this.submitting = true;
      try {
        const jobs = this.selectedPlatforms
          .map((p) => ({
            platform: p,
            account_id: this.accountByPlatform[p] as number,
          }))
          .filter((j) => j.account_id != null);

        const res = await fetch(`${daemon.url}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: this.title,
            video_path: this.videoPath,
            caption: this.caption,
            tags: [],
            cover_horizontal:
              this.coverMode === "file" ? this.coverHorizontal || null : null,
            cover_vertical:
              this.coverMode === "file" ? this.coverVertical || null : null,
            schedule_policy: this.schedulePolicy,
            publish_mode: this.publishMode,
            publish_at:
              this.schedulePolicy === "scheduled" ? this.publishAt : null,
            silent: this.silent,
            jobs,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        this.error = "";
        return body as TaskResult;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.submitting = false;
      }
    },

    /** 把 el-date-picker 的 Date 转成后端约定的本地时间字符串。 */
    setPublishAt(date: Date | null): void {
      this.publishAt = date ? formatDateTime(date) : null;
    },

    reset(): void {
      this.$reset();
    },
  },
});
