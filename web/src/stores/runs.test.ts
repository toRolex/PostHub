import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { officialApi } from "../api/official";
import { useRunStore, initialRunState, LATEST_RUN_ID_KEY } from "./runs";

const SNAPSHOT = {
  runId: "run-1",
  status: "completed" as const,
  createdAt: "2026-08-27T00:00:00.000+00:00",
  updatedAt: "2026-08-27T00:00:00.100+00:00",
  completedAt: "2026-08-27T00:00:00.100+00:00",
  summary: {
    itemCount: 1,
    pendingCount: 0,
    runningCount: 0,
    successCount: 1,
    failedCount: 0,
    completedCount: 1,
  },
  items: [{ itemId: "item-1", status: "success" as const, error: null }],
};

describe("run store（查询 API 是生命周期事实来源）", () => {
  beforeEach(() => {
    localStorage.clear();
    useRunStore.setState(initialRunState);
  });

  afterEach(() => vi.restoreAllMocks());

  it("受理响应只保存 runId/pending，不写 item success", () => {
    useRunStore.getState().rememberAcceptedRun({
      runId: "run-1",
      status: "pending",
      itemCount: 1,
    });

    const state = useRunStore.getState();
    expect(state.runId).toBe("run-1");
    expect(state.status).toBe("pending");
    expect(state.snapshot).toBeNull();
    expect(JSON.parse(localStorage.getItem(LATEST_RUN_ID_KEY)!)).toBe("run-1");
  });

  it("刷新恢复最近 run，并以查询结果更新为 completed/success", async () => {
    vi.spyOn(officialApi, "getLatestRun").mockResolvedValue(SNAPSHOT);

    await useRunStore.getState().restoreLatestRun("http://127.0.0.1:5409");

    const state = useRunStore.getState();
    expect(state.runId).toBe("run-1");
    expect(state.status).toBe("completed");
    expect(state.snapshot?.items[0].status).toBe("success");
  });

  it("轮询指定 run 只接受后端状态，不把 pending 解释成 success", async () => {
    vi.spyOn(officialApi, "getRun").mockResolvedValue({
      ...SNAPSHOT,
      status: "running",
      completedAt: null,
      items: [{ itemId: "item-1", status: "running", error: null }],
    });
    useRunStore.setState({ runId: "run-1", status: "pending" });

    await useRunStore.getState().refresh("http://127.0.0.1:5409");

    expect(useRunStore.getState().status).toBe("running");
    expect(useRunStore.getState().snapshot?.items[0].status).toBe("running");
  });

  it("旧 run 查询响应不能覆盖新受理的 run", async () => {
    let resolveOld!: (snapshot: typeof SNAPSHOT) => void;
    vi.spyOn(officialApi, "getRun").mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    useRunStore.setState({ runId: "run-1", status: "running" });

    const refresh = useRunStore.getState().refresh("http://127.0.0.1:5409");
    useRunStore.getState().rememberAcceptedRun({
      runId: "run-2",
      status: "pending",
      itemCount: 1,
    });
    resolveOld(SNAPSHOT);
    await refresh;

    expect(useRunStore.getState().runId).toBe("run-2");
    expect(useRunStore.getState().status).toBe("pending");
    expect(useRunStore.getState().snapshot).toBeNull();
  });

  it("恢复旧 latest 响应不能覆盖新受理的 run", async () => {
    let resolveOld!: (snapshot: typeof SNAPSHOT) => void;
    vi.spyOn(officialApi, "getLatestRun").mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );

    const restore = useRunStore.getState().restoreLatestRun("http://127.0.0.1:5409");
    useRunStore.getState().rememberAcceptedRun({
      runId: "run-2",
      status: "pending",
      itemCount: 1,
    });
    resolveOld(SNAPSHOT);
    await restore;

    expect(useRunStore.getState().runId).toBe("run-2");
    expect(useRunStore.getState().status).toBe("pending");
    expect(useRunStore.getState().snapshot).toBeNull();
  });

  it("无指针时初次 latest 失败，后续 refresh 会重试 latest", async () => {
    const getLatest = vi
      .spyOn(officialApi, "getLatestRun")
      .mockRejectedValueOnce(new Error("daemon 尚未就绪"))
      .mockResolvedValueOnce(SNAPSHOT);

    await useRunStore.getState().restoreLatestRun("http://127.0.0.1:5409");
    expect(useRunStore.getState().error).toBe("daemon 尚未就绪");

    await useRunStore.getState().refresh("http://127.0.0.1:5409");

    expect(getLatest).toHaveBeenCalledTimes(2);
    expect(useRunStore.getState().runId).toBe("run-1");
    expect(useRunStore.getState().status).toBe("completed");
  });

  it("刷新保留 completed_with_failures 和每项错误详情", async () => {
    const partial = {
      ...SNAPSHOT,
      status: "completed_with_failures" as const,
      summary: {
        ...SNAPSHOT.summary,
        itemCount: 3,
        successCount: 2,
        failedCount: 1,
        completedCount: 3,
      },
      items: [
        { itemId: "item-1", seq: 1, status: "success" as const, error: null },
        {
          itemId: "item-2",
          seq: 2,
          status: "failed" as const,
          error: "平台拒绝",
          errorSummary: "平台拒绝",
          errorDetail: "平台拒绝：详细原因",
        },
      ],
    };
    vi.spyOn(officialApi, "getRun").mockResolvedValue(partial);
    useRunStore.setState({ runId: "run-1", status: "running" });

    await useRunStore.getState().refresh("http://127.0.0.1:5409");

    expect(useRunStore.getState().status).toBe("completed_with_failures");
    expect(useRunStore.getState().snapshot?.items[1].errorDetail).toBe("平台拒绝：详细原因");
  });

  it("网络错误保留最后快照，后续 refresh 继续查询", async () => {
    const getRun = vi
      .spyOn(officialApi, "getRun")
      .mockRejectedValueOnce(new Error("网络断开"))
      .mockResolvedValueOnce(SNAPSHOT);
    useRunStore.setState({ runId: "run-1", status: "running", snapshot: SNAPSHOT });

    await useRunStore.getState().refresh("http://127.0.0.1:5409");
    expect(useRunStore.getState().snapshot).toBe(SNAPSHOT);
    expect(useRunStore.getState().status).toBe("running");
    expect(useRunStore.getState().error).toBe("网络断开");

    await useRunStore.getState().refresh("http://127.0.0.1:5409");
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(useRunStore.getState().error).toBe("");
  });

  it("stale localStorage runId 查询失败时 refresh 会回退 latest", async () => {
    localStorage.setItem(LATEST_RUN_ID_KEY, JSON.stringify("stale-run"));
    const getRun = vi
      .spyOn(officialApi, "getRun")
      .mockRejectedValue(new Error("run 不存在"));
    vi.spyOn(officialApi, "getLatestRun").mockResolvedValue(SNAPSHOT);

    await useRunStore.getState().refresh("http://127.0.0.1:5409");

    expect(getRun).toHaveBeenCalledWith("http://127.0.0.1:5409", "stale-run");
    expect(useRunStore.getState().runId).toBe("run-1");
    expect(useRunStore.getState().status).toBe("completed");
    expect(JSON.parse(localStorage.getItem(LATEST_RUN_ID_KEY)!)).toBe("run-1");
  });
});
