import { defineStore } from "pinia";

export interface DaemonHealth {
  status: string;
  version: string;
  port?: number;
}

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8756";

interface DaemonState {
  url: string;
  health: DaemonHealth | null;
  connected: boolean;
  checking: boolean;
  error: string;
  pollIntervalMs: number;
}

export const useDaemonStore = defineStore("daemon", {
  state: (): DaemonState => ({
    url: DEFAULT_DAEMON_URL,
    health: null,
    connected: false,
    checking: false,
    error: "",
    pollIntervalMs: 5000,
  }),

  actions: {
    /** 请求守护进程 /health，刷新连通状态。 */
    async checkHealth(): Promise<void> {
      this.checking = true;
      try {
        const res = await fetch(`${this.url}/health`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        this.health = (await res.json()) as DaemonHealth;
        this.connected = this.health.status === "ok";
        this.error = "";
      } catch (e) {
        this.connected = false;
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.checking = false;
      }
    },
  },
});
