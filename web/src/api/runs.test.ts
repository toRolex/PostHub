import { afterEach, describe, expect, it, vi } from "vitest";
import { officialApi, type PostVideoRequest } from "./official";

const PAYLOAD: PostVideoRequest = {
  fileList: ["video.mp4"],
  accountList: ["douyin.json"],
  type: 3,
  title: "立即 item",
  tags: ["测试"],
  enableTimer: false,
};

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}

describe("accepted run API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("acceptRun POST /postRuns 只解析 accepted run，不伪造 success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        code: 200,
        msg: "已受理",
        data: { runId: "run-1", status: "pending", itemCount: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const accepted = await officialApi.acceptRun("http://127.0.0.1:5409", PAYLOAD);

    expect(accepted).toEqual({ runId: "run-1", status: "pending", itemCount: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/postRuns",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(PAYLOAD);
  });

  it("getRun 与 getLatestRun 返回查询 API 的事实状态", async () => {
    const snapshot = {
      runId: "run-1",
      status: "completed",
      createdAt: "2026-08-27T00:00:00.000+00:00",
      updatedAt: "2026-08-27T00:00:00.100+00:00",
      completedAt: "2026-08-27T00:00:00.100+00:00",
      items: [{ itemId: "item-1", status: "success", error: null }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ code: 200, msg: null, data: snapshot }))
      .mockResolvedValueOnce(response({ code: 200, msg: null, data: snapshot }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(officialApi.getRun("http://127.0.0.1:5409", "run-1")).resolves.toEqual(
      snapshot,
    );
    await expect(officialApi.getLatestRun("http://127.0.0.1:5409")).resolves.toEqual(snapshot);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:5409/postRuns/run-1");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:5409/postRuns/latest");
  });
});
