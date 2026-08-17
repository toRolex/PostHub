import { create } from "zustand";
import { officialApi } from "../api/official";
import type { OfficialFileRecord } from "../api/types";
import { useDaemonStore } from "./daemon";

interface FilesState {
  files: OfficialFileRecord[];
  loading: boolean;
  uploading: boolean;
  deletingId: number | null;
  error: string;
  fetchFiles: () => Promise<void>;
  upload: (file: File, customName?: string) => Promise<void>;
  removeFile: (id: number) => Promise<void>;
}

export const initialFilesState = {
  files: [] as OfficialFileRecord[],
  loading: false,
  uploading: false,
  deletingId: null as number | null,
  error: "",
};

export const useFilesStore = create<FilesState>()((set) => ({
  ...initialFilesState,

  fetchFiles: async () => {
    set({ loading: true });
    try {
      const files = await officialApi.getFiles(useDaemonStore.getState().url);
      set({ files, error: "" });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  /** 上传素材：官方 /uploadSave（进磁盘 + 写 file_records），成功后刷新列表。 */
  upload: async (file, customName) => {
    set({ uploading: true });
    try {
      await officialApi.upload(useDaemonStore.getState().url, file, customName);
      set({ error: "" });
      await useFilesStore.getState().fetchFiles();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ uploading: false });
    }
  },

  /** 删除素材：官方 /deleteFile（删磁盘 + 删记录），成功后从列表移除。 */
  removeFile: async (id) => {
    set({ deletingId: id });
    try {
      await officialApi.deleteFile(useDaemonStore.getState().url, id);
      set((s) => ({ files: s.files.filter((f) => f.id !== id), error: "" }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ deletingId: null });
    }
  },
}));