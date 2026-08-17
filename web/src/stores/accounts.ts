import { create } from "zustand";
import { officialApi } from "../api/official";
import type { DaoUserInfo, OfficialAccount } from "../api/types";
import { OFFICIAL_TYPE_PLATFORM } from "../api/types";
import { useDaemonStore } from "./daemon";

/** 官方 user_info 行 -> 展示模型（复用旧 Account 核心字段，兼容发布页）。 */
export function mapDaoAccount(row: DaoUserInfo): OfficialAccount {
  return {
    id: row.id,
    typeNum: row.type,
    platform: OFFICIAL_TYPE_PLATFORM[row.type],
    name: row.userName,
    cookieFile: row.filePath,
    cookieValid: row.status === 1,
    status: row.status,
    // 以下兼容字段保留旧接口空值（官方无 Chrome/CDP 概念）。
    profile_dir: "",
    cdp_port: 0,
    chrome_path: null,
    last_login_at: null,
    last_publish_at: null,
    created_at: "",
    updated_at: "",
  };
}

async function fetchValidInner(): Promise<DaoUserInfo[]> {
  return officialApi.getValidAccounts(useDaemonStore.getState().url);
}

/** 用 getValidAccounts 校验结果更新 cookie 有效性（官方：校验后逐行落库 status 0/1）。 */
function mergeCookieValidity(
  accounts: OfficialAccount[],
  valid: DaoUserInfo[],
): { accounts: OfficialAccount[]; ids: Set<number> } {
  const byId = new Map(valid.map((v) => [v.id, v]));
  return {
    accounts: accounts.map((a) => {
      const v = byId.get(a.id);
      const ok = v ? v.status === 1 : a.cookieValid;
      return { ...a, status: ok ? 1 : 0, cookieValid: ok };
    }),
    ids: new Set(valid.filter((v) => v.status === 1).map((v) => v.id)),
  };
}

interface AccountsState {
  /** 账号列表（getValidAccounts 校验后的真实有效态）。 */
  accounts: OfficialAccount[];
  /** 最近一次校验状态（列表页展示 cookie 有效性）。 */
  validAccountIds: Set<number>;
  loading: boolean;
  error: string;
  fetchingValid: boolean;
  fetchAccounts: () => Promise<void>;
  refetchValidAccounts: () => Promise<void>;
  removeAccount: (id: number) => Promise<void>;
}

export const initialAccountsState = {
  accounts: [] as OfficialAccount[],
  validAccountIds: new Set<number>(),
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
        fetchValidInner(),
      ]);
      const { accounts, ids } = mergeCookieValidity(
        all.map(mapDaoAccount),
        valid,
      );
      set({ accounts, validAccountIds: ids, error: "" });
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
      const valid = await fetchValidInner();
      const { accounts, ids } = mergeCookieValidity(get().accounts, valid);
      set({ accounts, validAccountIds: ids, error: "" });
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
        validAccountIds: new Set([...s.validAccountIds].filter((x) => x !== id)),
        error: "",
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
}));