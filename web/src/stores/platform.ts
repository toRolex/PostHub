import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";

export type Platform = "douyin" | "xiaohongshu" | "wechat";

export interface PlatformConstraint {
  platform: Platform;
  label: string;
  min_lead_time_seconds: number;
  schedule_min_seconds: number;
  schedule_max_seconds: number;
  max_scheduled_per_day: number | null;
  cover_required: boolean;
  auto_cover_first_frame: boolean;
}

type ConstraintMap = Partial<Record<Platform, PlatformConstraint>>;

interface PlatformState {
  constraints: ConstraintMap;
  loading: boolean;
  error: string;
}

export const usePlatformStore = defineStore("platform", {
  state: (): PlatformState => ({
    constraints: {},
    loading: false,
    error: "",
  }),

  getters: {
    list: (state): PlatformConstraint[] =>
      (Object.values(state.constraints) as PlatformConstraint[]).filter(
        (c) => c != null,
      ),
  },

  actions: {
    /** 请求守护进程 /platform-constraints，拉取平台约束注册表。 */
    async fetchConstraints(): Promise<void> {
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/platform-constraints`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        const list = (body.constraints ?? []) as PlatformConstraint[];
        const map: ConstraintMap = {};
        for (const c of list) {
          map[c.platform] = c;
        }
        this.constraints = map;
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },
  },
});
