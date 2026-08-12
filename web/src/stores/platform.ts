import { create } from "zustand";
import { api } from "../api/client";
import type { ConstraintMap } from "../api/types";
import { useDaemonStore } from "./daemon";

interface PlatformState {
  constraints: ConstraintMap;
  loading: boolean;
  error: string;
  fetchConstraints: () => Promise<void>;
}

export const initialPlatformState = {
  constraints: {} as ConstraintMap,
  loading: false,
  error: "",
};

export const usePlatformStore = create<PlatformState>()((set) => ({
  ...initialPlatformState,

  /** 请求守护进程 /platform-constraints，拉取平台约束注册表。 */
  fetchConstraints: async () => {
    set({ loading: true });
    try {
      const body = await api.platformConstraints(useDaemonStore.getState().url);
      const map: ConstraintMap = {};
      for (const c of body.constraints) {
        map[c.platform] = c;
      }
      set({ constraints: map, error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
}));
