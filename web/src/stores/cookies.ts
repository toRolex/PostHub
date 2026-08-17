/**
 * Cookie 导入/导出 store —— 直连官方后端 seam（sau_backend 原生 cookie 端点）。
 *
 * 与「账号管理」store 的差异：官方 `/getAccounts` 返回的是 user_info 表行
 * （数组行），域名与 PostHub daemon REST `/accounts`（每账号=本机 Chrome + 端口）
 * 不是同一模型。本 store 专管官方 cookie 维度：
 *   - fetchAccounts  → GET /getAccounts（不校验）
 *   - validateAll    → GET /getValidAccounts（逐行 check_cookie，失效置 0）
 *   - importCookie   → POST /uploadCookie（写入选中账号的 filePath）
 *   - exportCookie   → GET /downloadCookie（下载附件供备份/迁移）
 */
import { create } from "zustand";
import { api } from "../api/client";
import type {
  CookiedAccount,
  OfficialAccountRow,
  OfficialCookieStatus,
  OfficialPlatform,
} from "../api/types";
import { useDaemonStore } from "./daemon";

/** 官方 user_info 数组行 → 解析对象。 */
export function rowToCookiedAccount(row: OfficialAccountRow): CookiedAccount {
  const [id, type, filePath, userName, status] = row;
  return { id, type: type as OfficialPlatform, filePath, userName, status: status as OfficialCookieStatus };
}

interface CookiesState {
  accounts: CookiedAccount[];
  loading: boolean;
  validating: boolean;
  importingId: number | null;
  error: string;
  fetchAccounts: () => Promise<void>;
  validateAll: () => Promise<void>;
  importCookie: (file: File, id: number) => Promise<void>;
  exportCookie: (filePath: string, fallbackName: string) => Promise<void>;
}

export const initialCookiesState = {
  accounts: [] as CookiedAccount[],
  loading: false,
  validating: false,
  importingId: null as number | null,
  error: "",
};

export const useCookiesStore = create<CookiesState>()((set) => ({
  ...initialCookiesState,

  fetchAccounts: async () => {
    set({ loading: true });
    try {
      const rows = await api.officialAccounts(useDaemonStore.getState().url);
      set({ accounts: rows.map(rowToCookiedAccount), error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  validateAll: async () => {
    set({ validating: true });
    try {
      const rows = await api.officialValidAccounts(useDaemonStore.getState().url);
      set({ accounts: rows.map(rowToCookiedAccount), error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ validating: false });
    }
  },

  importCookie: async (file, id) => {
    set({ importingId: id });
    try {
      const base = useDaemonStore.getState().url;
      const account = useCookiesStore.getState().accounts.find((a) => a.id === id);
      if (!account) throw new Error(`账号 ${id} 未加载，请先刷新列表`);
      await api.uploadCookie(base, file, id, account.type);
      // 导入后立即校验一次，让「导入 → 可校验账号」闭环（验收 1）。
      const rows = await api.officialValidAccounts(base);
      set({ accounts: rows.map(rowToCookiedAccount), error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ importingId: null });
    }
  },

  exportCookie: async (filePath, fallbackName) => {
    try {
      const base = useDaemonStore.getState().url;
      const res = await api.downloadCookie(base, filePath);
      if (!res.ok) {
        // 官方 /downloadCookie 出错返回 {code, msg}（如「Cookie文件不存在」），
        // 优先透传官方 msg，避免丢失体验信息。
        const text = await res.text().catch(() => "");
        let msg = "";
        try {
          msg = (JSON.parse(text) as { msg?: string }).msg ?? "";
        } catch {
          // 非 JSON 错误体按空处理
        }
        throw new Error(msg || `下载失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
}));