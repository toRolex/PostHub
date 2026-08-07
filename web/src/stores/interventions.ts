import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";
import type { Platform } from "./accounts";

export type InterventionKind = "manual" | "needs_relogin";

export interface Intervention {
  id: number;
  kind: InterventionKind;
  job_id: number;
  task_id: number;
  account_id: number;
  platform: Platform;
  message: string | null;
  error_type: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

interface InterventionsState {
  interventions: Intervention[];
  /** 本会话已提示过的事件 id，避免重复弹窗。 */
  seenIds: number[];
  loading: boolean;
  error: string;
}

export const useInterventionsStore = defineStore("interventions", {
  state: (): InterventionsState => ({
    interventions: [],
    seenIds: [],
    loading: false,
    error: "",
  }),

  getters: {
    pendingCount: (state) => state.interventions.length,
  },

  actions: {
    /** 请求守护进程 /interventions，拉取待人工介入事件。 */
    async fetchInterventions(): Promise<void> {
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/interventions`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        this.interventions = (body.interventions ?? []) as Intervention[];
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 标记事件已处理：POST /interventions/{id}/ack，并从本地 pending 出列。 */
    async acknowledge(id: number): Promise<void> {
      const daemon = useDaemonStore();
      const res = await fetch(`${daemon.url}/interventions/${id}/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.interventions = this.interventions.filter((iv) => iv.id !== id);
    },

    /**
     * 轮询 /interventions：对新事件触发弹窗提示（Tauri 弹窗 / 浏览器内提示），
     * 提示后 acknowledge 出列，避免下轮重复弹窗。返回本周期提示的事件数。
     */
    async poll(): Promise<number> {
      await this.fetchInterventions();
      let notified = 0;
      for (const iv of this.interventions) {
        if (this.seenIds.includes(iv.id)) continue;
        this.seenIds = [...this.seenIds, iv.id];
        const { notifyIntervention } = await import("../lib/interventionNotify");
        try {
          await notifyIntervention(iv);
        } finally {
          // 提示后出列（无论用户是否点确认，避免重复打扰）
          void this.acknowledge(iv.id).catch(() => undefined);
        }
        notified += 1;
      }
      return notified;
    },
  },
});
