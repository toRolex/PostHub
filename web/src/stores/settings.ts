import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/isTauri";

/**
 * 设置 store —— 目前承载「本地 Chrome 可执行文件路径」。
 *
 * 该路径经 Tauri IPC 持久化到 app_data/settings.json；
 * 桌面壳启动 daemon 时以其注入 `POSTHUB_LOCAL_CHROME_PATH`，
 * daemon conf.py 的 `LOCAL_CHROME_PATH` 据此读取（登录/上传用本地 Chrome）。
 *
 * 非 Tauri（浏览器开发）环境下 IPC 不可用，读写均安全降级为空/不抛错。
 */
interface SettingsState {
  /** 当前配置的本地 Chrome 路径（空串 = 未配置/使用自带 Chromium）。 */
  chromePath: string;
  loading: boolean;
  error: string;
  /** 从桌面壳读当前配置。 */
  load: () => Promise<void>;
  /** 保存本地 Chrome 路径（空串 = 清除配置）。保存后需重启 daemon 生效。 */
  save: (path: string) => Promise<void>;
}

export const initialSettingsState = {
  chromePath: "",
  loading: false,
  error: "",
};

export const useSettingsStore = create<SettingsState>()((set) => ({
  ...initialSettingsState,

  load: async () => {
    if (!isTauri()) {
      set({ chromePath: "", loading: false, error: "" });
      return;
    }
    set({ loading: true });
    try {
      const path = await invoke<string>("get_chrome_path");
      set({ chromePath: path, error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  save: async (path) => {
    if (!isTauri()) {
      set({ chromePath: path.trim(), error: "" });
      return;
    }
    set({ loading: true });
    try {
      const saved = await invoke<string>("set_chrome_path", { path: path.trim() });
      set({ chromePath: saved, error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  },
}));
