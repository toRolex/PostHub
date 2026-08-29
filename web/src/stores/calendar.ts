import { create } from "zustand";
import { officialApi, type PublishRecord } from "../api/official";

interface CalendarState {
  records: PublishRecord[];
  from: string | null;
  to: string | null;
  loading: boolean;
  error: string;
  fetchRecords: (base: string, from: string, to: string) => Promise<void>;
}

export const initialCalendarState = {
  records: [] as PublishRecord[],
  from: null as string | null,
  to: null as string | null,
  loading: false,
  error: "",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useCalendarStore = create<CalendarState>()((set) => ({
  ...initialCalendarState,

  fetchRecords: async (base, from, to) => {
    set({ loading: true });
    try {
      const records = await officialApi.getPublishRecords(base, from, to);
      set({ records, from, to, loading: false, error: "" });
    } catch (error) {
      // 查询失败不是“本周无记录”：保留上次成功快照，只更新错误提示。
      set({ loading: false, error: messageOf(error) });
    }
  },
}));
