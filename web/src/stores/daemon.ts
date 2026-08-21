import { create } from "zustand";
import { DEFAULT_DAEMON_URL } from "../api/types";
import { withMutation } from "./_withMutation";

interface DaemonState {
  url: string;
  connected: boolean;
  checking: boolean;
  error: string;
  pollIntervalMs: number;
  /** 探活官方后端：官方无 /health 路由，用 /getAccounts 的裸 fetch 判 res.ok 作就绪信号。 */
  probeDaemon: () => Promise<void>;
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

  /**
   * 探活官方后端：官方无 /health 路由，用 /getAccounts 判 res.ok（2xx 视为就绪）。
   * 保留裸 fetch 而不复用 officialApi.getAccounts：可达性 ≠ 数据完整性，
   * user_info 脏行会让 mapRows 抛错，从而把「后端在线」误判为离线。
   */
  probeDaemon: () =>
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
