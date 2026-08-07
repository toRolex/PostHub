import { defineStore } from "pinia";

import { useDaemonStore } from "./daemon";

export type Platform = "douyin" | "xiaohongshu" | "wechat";
export type AccountStatus = "active" | "needs_relogin" | "disabled";

export interface Account {
  id: number;
  platform: Platform;
  name: string;
  profile_dir: string;
  cdp_port: number;
  chrome_path: string | null;
  status: AccountStatus;
  last_login_at: string | null;
  last_publish_at: string | null;
  created_at: string;
  updated_at: string;
  launch_warning?: string;
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  creating: boolean;
  error: string;
}

export const useAccountsStore = defineStore("accounts", {
  state: (): AccountsState => ({
    accounts: [],
    loading: false,
    creating: false,
    error: "",
  }),

  getters: {
    count: (state) => state.accounts.length,
  },

  actions: {
    /** 请求守护进程 /accounts，刷新账号列表。 */
    async fetchAccounts(): Promise<void> {
      const daemon = useDaemonStore();
      this.loading = true;
      try {
        const res = await fetch(`${daemon.url}/accounts`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = await res.json();
        this.accounts = body.accounts ?? [];
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    /** 添加账号：POST /accounts，守护进程拉起独立 Chrome 扫码登录。 */
    async createAccount(payload: {
      platform: Platform;
      name?: string;
    }): Promise<Account> {
      const daemon = useDaemonStore();
      this.creating = true;
      try {
        const res = await fetch(`${daemon.url}/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const account = body.account as Account;
        this.accounts = [...this.accounts, account];
        this.error = "";
        return account;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.creating = false;
      }
    },

    /** 删除账号：DELETE /accounts/{id}，移除记录并清理关联。 */
    async removeAccount(id: number): Promise<void> {
      const daemon = useDaemonStore();
      try {
        const res = await fetch(`${daemon.url}/accounts/${id}`, {
          method: "DELETE",
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        this.accounts = this.accounts.filter((a) => a.id !== id);
        this.error = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  },
});
