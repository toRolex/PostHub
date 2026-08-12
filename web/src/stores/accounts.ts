import { create } from "zustand";
import { api } from "../api/client";
import type { Account, AccountStatus, Platform } from "../api/types";
import { useDaemonStore } from "./daemon";

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  creating: boolean;
  error: string;
  fetchAccounts: () => Promise<void>;
  createAccount: (payload: { platform: Platform; name?: string }) => Promise<Account>;
  removeAccount: (id: number) => Promise<void>;
  relogin: (id: number) => Promise<{ ok: boolean; launch_warning?: string }>;
  setStatus: (id: number, status: AccountStatus) => Promise<void>;
}

export const initialAccountsState = {
  accounts: [] as Account[],
  loading: false,
  creating: false,
  error: "",
};

export const useAccountsStore = create<AccountsState>()((set) => ({
  ...initialAccountsState,

  fetchAccounts: async () => {
    set({ loading: true });
    try {
      const body = await api.accounts(useDaemonStore.getState().url);
      set({ accounts: body.accounts ?? [], error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /** 添加账号：POST /accounts，守护进程拉起独立 Chrome 扫码登录。 */
  createAccount: async (payload) => {
    set({ creating: true });
    try {
      const body = await api.createAccount(useDaemonStore.getState().url, payload);
      set((s) => ({ accounts: [...s.accounts, body.account], error: "" }));
      return body.account;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ creating: false });
    }
  },

  removeAccount: async (id) => {
    try {
      await api.deleteAccount(useDaemonStore.getState().url, id);
      set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id), error: "" }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  /** 重登引导（issue #21）：拉起该账号 Chrome 供重新扫码。 */
  relogin: async (id) => {
    try {
      const body = await api.reloginAccount(useDaemonStore.getState().url, id);
      set({ error: "" });
      return body;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  /** 更新账号状态（issue #21）：重新扫码后恢复 active，或手动停用。 */
  setStatus: async (id, status) => {
    try {
      await api.setAccountStatus(useDaemonStore.getState().url, id, status);
      set((s) => ({
        accounts: s.accounts.map((a) => (a.id === id ? { ...a, status } : a)),
        error: "",
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
}));
