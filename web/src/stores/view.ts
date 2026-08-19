import { create } from "zustand";

export type View = "publish" | "files" | "accounts" | "schedule" | "settings";

interface ViewState {
  view: View;
  setView: (view: View) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  view: "publish",
  setView: (view) => set({ view }),
}));
