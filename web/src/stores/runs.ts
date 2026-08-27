import { create } from "zustand";
import {
  officialApi,
  type AcceptedRun,
  type RunSnapshot,
  type RunStatus,
} from "../api/official";

export const LATEST_RUN_ID_KEY = "posthub.latestRunId";

export interface RunState {
  runId: string | null;
  status: RunStatus | null;
  snapshot: RunSnapshot | null;
  error: string;
  rememberAcceptedRun: (accepted: AcceptedRun) => void;
  refresh: (base: string) => Promise<void>;
  restoreLatestRun: (base: string) => Promise<void>;
}

export const initialRunState: Omit<
  RunState,
  "rememberAcceptedRun" | "refresh" | "restoreLatestRun"
> = {
  runId: null,
  status: null,
  snapshot: null,
  error: "",
};

function saveRunId(runId: string): void {
  try {
    localStorage.setItem(LATEST_RUN_ID_KEY, JSON.stringify(runId));
  } catch {
    // localStorage 不可用时仍保持本次内存态。
  }
}

function readRunId(): string | null {
  try {
    const raw = localStorage.getItem(LATEST_RUN_ID_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function clearRunId(): void {
  try {
    localStorage.removeItem(LATEST_RUN_ID_KEY);
  } catch {
    // localStorage 不可用时仍保持本次内存态。
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useRunStore = create<RunState>()((set, get) => {
  let mutationVersion = 0;
  let readSequence = 0;

  const canCommit = (requestId: number, version: number): boolean =>
    requestId === readSequence && version === mutationVersion;

  const applySnapshot = (snapshot: RunSnapshot): void => {
    saveRunId(snapshot.runId);
    set({
      runId: snapshot.runId,
      status: snapshot.status,
      snapshot,
      error: "",
    });
  };

  const fetchLatest = async (
    base: string,
    requestId: number,
    version: number,
  ): Promise<void> => {
    try {
      const snapshot = await officialApi.getLatestRun(base);
      if (!canCommit(requestId, version)) return;
      if (!snapshot) {
        clearRunId();
        set({ runId: null, status: null, snapshot: null, error: "" });
        return;
      }
      applySnapshot(snapshot);
    } catch (error) {
      if (canCommit(requestId, version)) set({ error: messageOf(error) });
    }
  };

  return {
    ...initialRunState,

    rememberAcceptedRun: (accepted) => {
      // 受理是新的权威内存事实：使所有在途 restore/refresh 响应失效。
      mutationVersion += 1;
      readSequence += 1;
      saveRunId(accepted.runId);
      set({
        runId: accepted.runId,
        status: accepted.status,
        snapshot: null,
        error: "",
      });
    },

    refresh: async (base) => {
      const requestId = ++readSequence;
      const version = mutationVersion;
      const runId = get().runId ?? readRunId();
      if (!runId) {
        // daemon 初启失败或尚未返回时，轮询必须持续探测 latest，而不是永久空态。
        await fetchLatest(base, requestId, version);
        return;
      }
      try {
        const snapshot = await officialApi.getRun(base, runId);
        if (!canCommit(requestId, version)) return;
        applySnapshot(snapshot);
      } catch (error) {
        if (!canCommit(requestId, version)) return;
        // 本地指针可能指向已清理的旧 run；查询失败时回退持久化 latest。
        await fetchLatest(base, requestId, version);
      }
    },

    restoreLatestRun: async (base) => {
      const requestId = ++readSequence;
      const version = mutationVersion;
      const remembered = readRunId();
      try {
        let snapshot: RunSnapshot | null;
        if (remembered) {
          try {
            snapshot = await officialApi.getRun(base, remembered);
          } catch (error) {
            if (!canCommit(requestId, version)) return;
            snapshot = await officialApi.getLatestRun(base);
          }
        } else {
          snapshot = await officialApi.getLatestRun(base);
        }
        if (!canCommit(requestId, version)) return;
        if (!snapshot) {
          clearRunId();
          set({ runId: null, status: null, snapshot: null, error: "" });
          return;
        }
        applySnapshot(snapshot);
      } catch (error) {
        if (canCommit(requestId, version)) set({ error: messageOf(error) });
      }
    },
  };
});
