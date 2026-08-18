import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openLoginSse,
  parseSseChunk,
  parseSseDataLine,
} from "../api/official";
import { buildPostVideoBatchRequest, officialApi } from "../api/official";

/** 构造一个 body 为 SSE 流的 mock Response（jsdom 支持 ReadableStream）。 */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(new TextEncoder().encode(c));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

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

describe("openLoginSse（官方轮询式 /login 句柄）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("二维码 + 200 成功，readResult 为 true，流结束后主动断开", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(["data: https://qr.example/x.png\n\n", "data: 200\n\n"]),
      ),
    );

    const handle = await openLoginSse({
      url: "http://127.0.0.1:9999",
      type: 3,
      accountName: "抖音一号",
    });

    const qr = await handle.readQr;
    expect(qr.src).toBe("https://qr.example/x.png");
    await expect(handle.readResult).resolves.toBe(true);
  });

  it("500 失败 -> readResult 为 false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(["data: 500\n\n"])),
    );

    const handle = await openLoginSse({
      url: "http://127.0.0.1:9999",
      type: 1,
      accountName: "小红书",
    });

    await expect(handle.readResult).resolves.toBe(false);
  });

  it("abort 取消 -> 未完成的 promise 以「登录已取消」拒绝", async () => {
    // 永不结束且不产数据的流（官方 sse_stream 死循环）：QR/result 均未决，只有 abort 能终止
    const neverEnding = new ReadableStream<Uint8Array>({
      start() {
        /* 不推送任何数据，永不 close */
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: neverEnding }),
    );

    const handle = await openLoginSse({
      url: "http://127.0.0.1:9999",
      type: 3,
      accountName: "x",
    });

    handle.abort();
    await expect(handle.readQr).rejects.toThrow("登录已取消");
    await expect(handle.readResult).rejects.toThrow("登录已取消");
  });

  it("HTTP 建立失败 -> 抛错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, body: null }),
    );
    await expect(
      openLoginSse({ url: "http://127.0.0.1:9999", type: 3, accountName: "x" }),
    ).rejects.toThrow("登录 SSE 建立失败");
  });
});

describe("officialApi 账号接口（mock fetch）", () => {
  const jsonResponse = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it("getAccounts 把行数组映射为 DaoUserInfo", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          code: 200,
          msg: null,
          data: [
            [1, 3, "a.json", "抖音一号", 1],
            [2, 1, "b.json", "小红书", 1],
          ],
        }),
      ),
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
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 500, msg: "获取账号列表失败: x", data: null }),
      ),
    );
    await expect(officialApi.getAccounts("http://x")).rejects.toThrow("获取账号列表失败: x");
  });

  it("getAccounts 响应非 JSON（如 500 错误页）-> 抛 HTTP 状态而非吞掉", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("Unexpected token");
        },
        text: async () => "<html>Bad Gateway</html>",
      }),
    );
    await expect(officialApi.getAccounts("http://x")).rejects.toThrow("HTTP 502");
  });

  it("getAccounts 未知平台类型 -> 抛校验错误", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          code: 200,
          msg: null,
          data: [[1, 9, "a.json", "未知", 1]],
        }),
      ),
    );
    await expect(officialApi.getAccounts("http://x")).rejects.toThrow("未知平台类型 9");
  });

  it("getValidAccounts 非 200 code 抛错", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 500, msg: "cookie 校验失败", data: null }),
      ),
    );
    await expect(officialApi.getValidAccounts("http://x")).rejects.toThrow("cookie 校验失败");
  });

  it("deleteAccount 非 200 code 抛错", async () => {
    const { officialApi } = await import("../api/official");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 404, msg: "account not found", data: null }, false, 404),
      ),
    );
    await expect(officialApi.deleteAccount("http://x", 1)).rejects.toThrow("account not found");
  });
});

describe("buildPostVideoBatchRequest（表单 → /postVideoBatch 契约）", () => {
  it("请求体是数组，每选中平台一个 postVideo 形态项；多文件 × 各平台多账号", () => {
    const body = buildPostVideoBatchRequest({
      files: ["a.mp4", "b.mp4"],
      title: "批量标题",
      caption: "正文",
      tags: ["批量", "发布"],
      platforms: [
        { platform: "douyin", accounts: ["d1.json", "d2.json"] },
        { platform: "xiaohongshu", accounts: ["x1.json"] },
      ],
    });
    expect(body).toHaveLength(2);
    // 抖音项：type=3 + 多文件 + 该平台多账号
    expect(body[0]).toMatchObject({
      fileList: ["a.mp4", "b.mp4"],
      accountList: ["d1.json", "d2.json"],
      type: 3,
      tags: ["批量", "发布"],
      enableTimer: false,
    });
    // 小红书项：type=1 + 该平台账号
    expect(body[1]).toMatchObject({
      fileList: ["a.mp4", "b.mp4"],
      accountList: ["x1.json"],
      type: 1,
    });
    // 标题/描述折叠与单视频同规则
    expect(body[0].title).toBe("批量标题\n正文");
    expect(body[1].title).toBe("批量标题\n正文");
  });

  it("空 caption 时标题不折叠", () => {
    const body = buildPostVideoBatchRequest({
      files: ["a.mp4"],
      title: "纯标题",
      tags: [],
      platforms: [{ platform: "douyin", accounts: ["d1.json"] }],
    });
    expect(body[0].title).toBe("纯标题");
  });

  it("平台整型映射：1 小红书 2 视频号 3 抖音 4 快手", () => {
    const make = (platform: Parameters<typeof buildPostVideoBatchRequest>[0]["platforms"][0]["platform"]) =>
      buildPostVideoBatchRequest({
        files: ["a.mp4"],
        title: "x",
        tags: [],
        platforms: [{ platform, accounts: ["a.json"] }],
      })[0].type;
    expect(make("xiaohongshu")).toBe(1);
    expect(make("wechat")).toBe(2);
    expect(make("douyin")).toBe(3);
    expect(make("kuaishou")).toBe(4);
  });
});

describe("officialApi.postVideoBatch（mock fetch）", () => {
  it("POST /postVideoBatch 并携带数组合法请求体", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, msg: null, data: null }),
      text: async () => JSON.stringify({ code: 200, msg: null, data: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await officialApi.postVideoBatch("http://127.0.0.1:5409", [
      { fileList: ["a.mp4"], accountList: ["d.json"], type: 3, title: "t", tags: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/postVideoBatch",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(Array.isArray(sent)).toBe(true);
    expect(sent[0].type).toBe(3);
    expect(sent[0].fileList).toEqual(["a.mp4"]);
  });

  it("官方校验错误（code 400）透传 msg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 400, msg: "Expected a JSON array", data: null }),
        text: async () => JSON.stringify({ code: 400, msg: "Expected a JSON array", data: null }),
      }),
    );
    await expect(
      officialApi.postVideoBatch("http://127.0.0.1:5409", []),
    ).rejects.toThrow("Expected a JSON array");
  });
});
