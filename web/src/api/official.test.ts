import { describe, expect, it, vi } from "vitest";

import { parseSseChunk, parseSseDataLine } from "../api/official";

describe("SSE 解析（官方轮询式 /login）", () => {
  it("data 行解析", () => {
    expect(parseSseDataLine("data: abc")).toBe("abc");
    expect(parseSseDataLine("data:data:203")).toBe("data:203");
    expect(parseSseDataLine(": comment")).toBe(null);
    expect(parseSseDataLine("event: login")).toBe(null);
    expect(parseSseDataLine("data:  ")).toBe(null);
  });

  it("单条二维码消息：base64 data URL 前缀", () => {
    const events = parseSseChunk('data: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==\n\n');
    expect(events).toEqual([{ kind: "qr", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" }]);
  });

  it("多帧：二维码 -> 200 成功", () => {
    const chunk = [
      "data: https://qr.example/x.png",
      "",
      "data: 200",
      "",
    ].join("\n");
    const events = parseSseChunk(chunk);
    expect(events).toEqual([
      { kind: "qr", src: "https://qr.example/x.png" },
      { kind: "success" },
    ]);
  });

  it("500 失败事件", () => {
    const events = parseSseChunk("data: 500\n\n");
    expect(events).toEqual([{ kind: "failed" }]);
  });

  it("跨网络分片：未闭合尾部不产出事件（由取用方保留缓冲续拼）", () => {
    // 第一条消息完整（含尾空行）；「data: 2」未闭合、不带空行 -> 不解析
    const events = parseSseChunk("data: data:image/png;base64,AAA\n\ndata: 2");
    expect(events).toEqual([{ kind: "qr", src: "data:image/png;base64,AAA" }]);
  });

  it("忽略注释行与空 comment，混有 stdout 噪声也能解析", () => {
    const events = parseSseChunk(": keepalive\ndata: x\n\n");
    expect(events).toEqual([{ kind: "qr", src: "x" }]);
  });
});

describe("officialApi 账号接口（mock fetch）", () => {
  it("getAccounts 把行数组映射为 DaoUserInfo", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          msg: null,
          data: [
            [1, 3, "a.json", "抖音一号", 1],
            [2, 1, "b.json", "小红书", 1],
          ],
        }),
      }),
    );
    const rows = await officialApi.getAccounts("http://127.0.0.1:9999");
    expect(rows).toEqual([
      { id: 1, type: 3, filePath: "a.json", userName: "抖音一号", status: 1 },
      { id: 2, type: 1, filePath: "b.json", userName: "小红书", status: 1 },
    ]);
  });

  it("getAccounts 非 200 code 抛错", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ code: 500, msg: "获取账号列表失败: x", data: null }),
      }),
    );
    await expect(officialApi.getAccounts("http://x")).rejects.toThrow("获取账号列表失败: x");
  });
});