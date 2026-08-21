import { create } from "zustand";
import { DEFAULT_DAEMON_URL } from "../api/types";
import { withMutation } from "./_withMutation";

interface DaemonState {
  url: string;
  connected: boolean;
  checking: boolean;
  error: string;
  pollIntervalMs: number;
  /** 探活官方后端：官方无 /health 路由，用 /getAccounts（无副作用、JSON 200）作就绪信号。 */
  checkHealth: () => Promise<void>;
}

export const initialDaemonState = {
  url: DEFAULT_DAEMON_URL,
  connected: false,
  checking: false,
  error: "",
  pollIntervalMs: 5000,
};

export const useDaemonStore = create<DaemonState>()((set, get) => ({
  ...initialDaemonState,

  /** 探活官方后端 /getAccounts：2xx 视为就绪（官方无 /health 路由）。 */
  checkHealth: () =>
    withMutation(
      set,
      async () => {
        const res = await fetch(`${get().url}/getAccounts`);
        set({ connected: res.ok, error: "" });
      },
      {
        begin: { checking: true },
        end: { checking: false },
        onError: (message) => ({ connected: false, error: message }),
      },
    ),
}));