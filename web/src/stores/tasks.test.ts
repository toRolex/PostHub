import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialTasksState, useTasksStore } from "./tasks";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function stubFetch(body: unknown, ok = true, status = 200) {
  const mock = vi.fn().mockResolvedValue(jsonResponse(body, ok, status));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const TASK_ITEM = {
  task: { id: 1, title: "春日踏青", status: "pending", created_at: "2026-08-08 00:00:00" },
  jobs: [{ id: 1, task_id: 1, platform: "douyin", status: "pending", attempt_count: 0 }],
};

describe("tasks store（任务列表 / 筛选 / 取消 / 重试）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useTasksStore.setState(initialTasksState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchTasks 无筛选 -> 请求 /tasks 并填充列表", async () => {
    const fetchMock = stubFetch({ tasks: [TASK_ITEM] });
    await useTasksStore.getState().fetchTasks();
    const s = useTasksStore.getState();
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].task.title).toBe("春日踏青");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9999/tasks");
  });

  it("fetchTasks 带筛选 -> 查询串含 platform/status/from/to", async () => {
    const fetchMock = stubFetch({ tasks: [TASK_ITEM] });
    await useTasksStore.getState().fetchTasks({
      platform: "douyin",
      status: "pending",
      from: "2026-08-01 00:00:00",
      to: "2026-08-08 00:00:00",
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/tasks?");
    expect(url).toContain("platform=douyin");
    expect(url).toContain("status=pending");
    expect(url).toContain("from=2026-08-01+00%3A00%3A00");
    expect(url).toContain("to=2026-08-08+00%3A00%3A00");
  });

  it("setFilters 持久化筛选并重新拉取", async () => {
    const fetchMock = stubFetch({ tasks: [TASK_ITEM] });
    await useTasksStore.getState().fetchTasks();
    useTasksStore.getState().setFilters({ platform: "wechat" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(useTasksStore.getState().filters.platform).toBe("wechat");
    const url = fetchMock.mock.calls[1][0] as string;
    expect(url).toContain("platform=wechat");
  });

  it("cancelTask -> POST /tasks/{id}/cancel 后刷新列表", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, canceled: [{ id: 1, status: "failed" }] }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [TASK_ITEM] }));
    vi.stubGlobal("fetch", fetchMock);
    await useTasksStore.getState().cancelTask(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/tasks/1/cancel");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 取消后刷新列表
  });

  it("retryJob -> POST /jobs/{id}/retry 后刷新列表", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, job: { id: 1, status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [TASK_ITEM] }));
    vi.stubGlobal("fetch", fetchMock);
    const job = await useTasksStore.getState().retryJob(1);
    expect(job?.status).toBe("pending");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/jobs/1/retry");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("服务端错误 -> error 填充且不抛异常", async () => {
    stubFetch({ error: "任务不存在" }, false, 404);
    await useTasksStore.getState().fetchTasks();
    expect(useTasksStore.getState().error).toBe("任务不存在");
    expect(useTasksStore.getState().tasks).toEqual([]);
  });
});
