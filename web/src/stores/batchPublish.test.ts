import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialBatchPublishState,
  useBatchPublishStore,
  validateBatch,
} from "./batchPublish";
import { useDaemonStore } from "./daemon";
import { useAccountsStore, initialAccountsState } from "./accounts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

/** 官方账号（含 cookieFile，供 accountList 构造用）。 */
const ACCOUNTS = [
  {
    id: 1,
    platform: "douyin",
    name: "抖音一号",
    status: 1,
    cookieFile: "douyin_a.json",
    typeNum: 3,
    cookieValid: true,
  },
  {
    id: 2,
    platform: "douyin",
    name: "抖音二号",
    status: 1,
    cookieFile: "douyin_b.json",
    typeNum: 3,
    cookieValid: true,
  },
  {
    id: 3,
    platform: "xiaohongshu",
    name: "小红书A",
    status: 1,
    cookieFile: "xhs_a.json",
    typeNum: 1,
    cookieValid: true,
  },
];

describe("batchPublish store（批量发布表单 → 官方 /postVideoBatch）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useAccountsStore.setState({
      ...initialAccountsState,
      accounts: ACCOUNTS as never,
    });
    useBatchPublishStore.setState(initialBatchPublishState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submit 成功 -> 每次选中平台一项；多文件 × 该平台多账号", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    useBatchPublishStore.setState({
      title: "批量标题",
      tags: "批量 发布",
      selectedFiles: ["a.mp4", "b.mp4"],
      accountIdsByPlatform: {
        douyin: [1, 2],
        xiaohongshu: [3],
        wechat: [],
        kuaishou: [],
      },
    });

    await useBatchPublishStore.getState().submit();

    // 一次 POST /postVideoBatch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/postVideoBatch");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);

    const douyin = body.find((x: { type: number }) => x.type === 3);
    expect(douyin.fileList).toEqual(["a.mp4", "b.mp4"]);
    expect(douyin.accountList).toEqual(["douyin_a.json", "douyin_b.json"]);
    expect(douyin.enableTimer).toBe(false);

    const xhs = body.find((x: { type: number }) => x.type === 1);
    expect(xhs.fileList).toEqual(["a.mp4", "b.mp4"]);
    expect(xhs.accountList).toEqual(["xhs_a.json"]);

    const s = useBatchPublishStore.getState();
    expect(s.batchResult?.total).toBe(2);
    expect(s.batchResult?.okCount).toBe(2);
    expect(s.batchResult?.items.douyin?.ok).toBe(true);
    expect(s.batchResult?.items.xiaohongshu?.ok).toBe(true);
  });

  it("校验失败（无标题/无素材/无账号）-> 抛错且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(/标题|素材|账号/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("官方请求级错误（如无登录态 400/401）-> 各平台子项统一失败并透传 msg", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 400, msg: "Expected a JSON array", data: null }, false, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    useBatchPublishStore.setState({
      title: "批量标题",
      selectedFiles: ["a.mp4"],
      accountIdsByPlatform: {
        douyin: [1],
        xiaohongshu: [3],
        wechat: [],
        kuaishou: [],
      },
    });

    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      "Expected a JSON array",
    );
    const s = useBatchPublishStore.getState();
    expect(s.batchResult?.total).toBe(2);
    expect(s.batchResult?.okCount).toBe(0);
    expect(s.batchResult?.items.douyin?.ok).toBe(false);
    expect(s.batchResult?.items.douyin?.msg).toBe("Expected a JSON array");
    expect(s.batchResult?.items.xiaohongshu?.ok).toBe(false);
  });

  it("validateBatch 返回可读错误", () => {
    expect(
      validateBatch({ title: "", selectedFiles: [], accountIdsByPlatform: {} }).some((e) =>
        e.includes("标题"),
      ),
    ).toBe(true);
    expect(
      validateBatch({ title: "x", selectedFiles: ["a.mp4"], accountIdsByPlatform: {} }).some(
        (e) => e.includes("账号"),
      ),
    ).toBe(true);
  });
});
