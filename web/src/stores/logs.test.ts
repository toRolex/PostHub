import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialLogsState, useLogsStore } from "./logs";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function stubFetch(body: unknown, ok = true, status = 200) {
  const mock = vi.fn().mockResolvedValue(jsonResponse(body, ok, status));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const LOG = {
  id: 1,
  task_id: 1,
  job_id: null,
  level: "info",
  source: "user",
  message: "取消任务 #1",
  created_at: "2026-08-08 00:00:00",
};

describe("logs store（应用内日志）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useLogsStore.setState(initialLogsState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchLogs 无筛选 -> 请求 /logs 并填充", async () => {
    const fetchMock = stubFetch({ logs: [LOG] });
    await useLogsStore.getState().fetchLogs();
    const s = useLogsStore.getState();
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0].message).toBe("取消任务 #1");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/logs");
  });

  it("fetchLogs 带 level/task_id -> 查询串", async () => {
    const fetchMock = stubFetch({ logs: [LOG] });
    await useLogsStore.getState().fetchLogs({ level: "error", task_id: 3 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("level=error");
    expect(url).toContain("task_id=3");
  });

  it("setFilters 持久化并重新拉取", async () => {
    const fetchMock = stubFetch({ logs: [LOG] });
    await useLogsStore.getState().fetchLogs();
    useLogsStore.getState().setFilters({ level: "warn" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(useLogsStore.getState().filters.level).toBe("warn");
    expect(fetchMock.mock.calls[1][0]).toContain("level=warn");
  });

  it("服务端错误 -> error 填充", async () => {
    stubFetch({ error: "boom" }, false, 500);
    await useLogsStore.getState().fetchLogs();
    expect(useLogsStore.getState().error).toBe("boom");
    expect(useLogsStore.getState().logs).toEqual([]);
  });
});
