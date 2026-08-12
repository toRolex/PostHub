import { create } from "zustand";
import { api } from "../api/client";
import type { Intervention } from "../api/types";
import { useDaemonStore } from "./daemon";

interface InterventionsState {
  interventions: Intervention[];
  /** 本会话已提示过的事件 id，避免重复弹窗。 */
  seenIds: number[];
  loading: boolean;
  error: string;
  fetchInterventions: () => Promise<void>;
  acknowledge: (id: number) => Promise<void>;
  /** 轮询：对新事件触发提示并出列；返回本周期提示的事件数。 */
  poll: () => Promise<number>;
}

export const selectPendingCount = (s: InterventionsState): number =>
  s.interventions.length;

export const initialInterventionsState = {
  interventions: [] as Intervention[],
  seenIds: [] as number[],
  loading: false,
  error: "",
};

export const useInterventionsStore = create<InterventionsState>()((set, get) => ({
  ...initialInterventionsState,

  fetchInterventions: async () => {
    set({ loading: true });
    try {
      const body = await api.interventions(useDaemonStore.getState().url);
      set({ interventions: body.interventions ?? [], error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /** 标记事件已处理：POST /interventions/{id}/ack，并从本地 pending 出列。 */
  acknowledge: async (id) => {
    await api.acknowledgeIntervention(useDaemonStore.getState().url, id);
    set((s) => ({ interventions: s.interventions.filter((iv) => iv.id !== id) }));
  },

  /**
   * 轮询 /interventions：对新事件触发提示（Tauri 弹窗 / 浏览器内 Toast），
   * 提示后 acknowledge 出列，避免下轮重复弹窗。返回本周期提示的事件数。
   */
  poll: async () => {
    await get().fetchInterventions();
    let notified = 0;
    for (const iv of get().interventions) {
      if (get().seenIds.includes(iv.id)) continue;
      set((s) => ({ seenIds: [...s.seenIds, iv.id] }));
      const { notifyIntervention } = await import("../lib/interventionNotify");
      try {
        await notifyIntervention(iv);
      } finally {
        // 提示后出列（无论用户是否点确认，避免重复打扰）
        await get()
          .acknowledge(iv.id)
          .catch(() => undefined);
      }
      notified += 1;
    }
    return notified;
  },
}));
