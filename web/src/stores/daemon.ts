import { create } from "zustand";
import { api } from "../api/client";
import { DEFAULT_DAEMON_URL, type DaemonHealth } from "../api/types";

interface DaemonState {
  url: string;
  health: DaemonHealth | null;
  connected: boolean;
  checking: boolean;
  error: string;
  pollIntervalMs: number;
  checkHealth: () => Promise<void>;
}

export const initialDaemonState = {
  url: DEFAULT_DAEMON_URL,
  health: null as DaemonHealth | null,
  connected: false,
  checking: false,
  error: "",
  pollIntervalMs: 5000,
};

export const useDaemonStore = create<DaemonState>()((set, get) => ({
  ...initialDaemonState,

  /** 请求守护进程 /health，刷新连通状态。 */
  checkHealth: async () => {
    set({ checking: true });
    try {
      const health = await api.health(get().url);
      set({ health, connected: health.status === "ok", error: "" });
    } catch (e) {
      set({ connected: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ checking: false });
    }
  },
}));
