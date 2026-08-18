import { create } from "zustand";
import { officialApi } from "../api/official";
import type { DaoUserInfo, OfficialAccount } from "../api/types";
import { OFFICIAL_TYPE_PLATFORM } from "../api/types";
import { useDaemonStore } from "./daemon";

/** 官方 user_info 行 -> 展示模型。 */
export function mapDaoAccount(row: DaoUserInfo): OfficialAccount {
  return {
    id: row.id,
    typeNum: row.type,
    platform: OFFICIAL_TYPE_PLATFORM[row.type],
    name: row.userName,
    cookieFile: row.filePath,
    cookieValid: row.status === 1,
    status: row.status,
  };
}

/** 拉取 getValidAccounts 校验结果（官方：校验后逐行落库 status 0/1）。 */
function loadValidAccounts(): Promise<DaoUserInfo[]> {
  return officialApi.getValidAccounts(useDaemonStore.getState().url);
}

/** 用校验结果更新 cookie 有效性。 */
function mergeCookieValidity(
  accounts: OfficialAccount[],
  valid: DaoUserInfo[],
): OfficialAccount[] {
  const byId = new Map(valid.map((v) => [v.id, v]));
  return accounts.map((a) => {
    const v = byId.get(a.id);
    const ok = v ? v.status === 1 : a.cookieValid;
    return { ...a, status: ok ? 1 : 0, cookieValid: ok };
  });
}

interface AccountsState {
  /** 账号列表（getValidAccounts 校验后的真实有效态）。 */
  accounts: OfficialAccount[];
  loading: boolean;
  error: string;
  fetchingValid: boolean;
  fetchAccounts: () => Promise<void>;
  refetchValidAccounts: () => Promise<void>;
  removeAccount: (id: number) => Promise<void>;
  updateAccount: (payload: {
    id: number;
    type: OfficialAccount["typeNum"];
    userName: string;
  }) => Promise<void>;
}

export const initialAccountsState = {
  accounts: [] as OfficialAccount[],
  loading: false,
  error: "",
  fetchingValid: false,
};

export const useAccountsStore = create<AccountsState>()((set, get) => ({
  ...initialAccountsState,

  /** 拉取账号列表：getAccounts（快）合并 getValidAccounts（cookie 校验）。 */
  fetchAccounts: async () => {
    set({ loading: true });
    try {
      const base = useDaemonStore.getState().url;
      const [all, valid] = await Promise.all([
        officialApi.getAccounts(base),
        loadValidAccounts(),
      ]);
      set({ accounts: mergeCookieValidity(all.map(mapDaoAccount), valid), error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /** 仅重新校验（删除后/登录后刷新 cookie 有效态）。 */
  refetchValidAccounts: async () => {
    set({ fetchingValid: true });
    try {
      const valid = await loadValidAccounts();
      set({ accounts: mergeCookieValidity(get().accounts, valid), error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ fetchingValid: false });
    }
  },

  /** 删除账号：官方 /deleteAccount，删除后本地移除。 */
  removeAccount: async (id) => {
    try {
      const base = useDaemonStore.getState().url;
      await officialApi.deleteAccount(base, id);
      set((s) => ({
        accounts: s.accounts.filter((a) => a.id !== id),
        error: "",
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  /** 更新账号的平台/名称：官方 /updateUserinfo，成功后刷新列表。 */
  updateAccount: async (payload: {
    id: number;
    type: OfficialAccount["typeNum"];
    userName: string;
  }) => {
    try {
      const base = useDaemonStore.getState().url;
      await officialApi.updateAccount(base, {
        id: payload.id,
        type: payload.type,
        userName: payload.userName,
      });
      set({ error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
}));
