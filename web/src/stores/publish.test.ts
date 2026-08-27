import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialPublishState,
  loadTimerPref,
  TIMER_PREF_KEY,
  usePublishStore,
} from "./publish";
import { useDaemonStore } from "./daemon";
import { useAccountsStore, initialAccountsState } from "./accounts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
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
    platform: "wechat",
    name: "视频号A",
    status: 1,
    cookieFile: "wechat_a.json",
    typeNum: 2,
    cookieValid: true,
  },
];

describe("publish store（发布表单 → 官方 /postVideo）", () => {
  beforeEach(() => {
    localStorage.clear();
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useAccountsStore.setState({ ...initialAccountsState, accounts: ACCOUNTS as never });
    usePublishStore.setState(initialPublishState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submit 成功 -> 每平台各调一次 /postVideo，携带官方契约体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: "发布任务已提交", data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePublishStore.setState({
      title: "春日踏青",
      caption: "一起出发",
      tags: "春天 旅行",
      selectedFile: "uuid_a_春天.mp4",
      selectedPlatforms: ["douyin", "wechat"],
      accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: 2, kuaishou: null },
    });

    await usePublishStore.getState().submit();

    // 两个平台各一次 POST /postVideo
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    for (const [url, init] of calls) {
      expect(url).toBe("http://127.0.0.1:9999/postVideo");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.fileList).toEqual(["uuid_a_春天.mp4"]);
      expect(body.tags).toEqual(["春天", "旅行"]);
      expect(body.enableTimer).toBe(false);
    }
    // 抖音 type=3 + accountList 用账号 cookieFile
    const douyinCall = calls.find(([, init]) =>
      (JSON.parse(init.body as string).type) === 3,
    )![1];
    expect(JSON.parse(douyinCall.body as string).accountList).toEqual(["douyin_a.json"]);
    // 视频号 type=2
    const wechatCall = calls.find(([, init]) =>
      (JSON.parse(init.body as string).type) === 2,
    )![1];
    expect(JSON.parse(wechatCall.body as string).accountList).toEqual(["wechat_a.json"]);

    const s = usePublishStore.getState();
    expect(s.results.douyin?.ok).toBe(true);
    expect(s.results.wechat?.ok).toBe(true);
  });

  it("submit 校验失败 -> 抛错且不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    usePublishStore.setState({ title: "", selectedPlatforms: ["douyin"] });

    await expect(usePublishStore.getState().submit()).rejects.toThrow(/标题/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("某个平台官方 400 -> 该平台失败消息透传，其余继续", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 400, msg: "账号列表不能为空", data: null }, false, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 200, msg: "发布任务已提交", data: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    usePublishStore.setState({
      title: "x",
      selectedFile: "a.mp4",
      selectedPlatforms: ["douyin", "wechat"],
      accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: 2, kuaishou: null },
    });
    // 抖音账号 cookieFile 置空以触发官方校验错误（douyin 先调用 → 400）
    useAccountsStore.setState({
      ...initialAccountsState,
      accounts: [
        { ...ACCOUNTS[0], cookieFile: "" },
        ACCOUNTS[1],
      ] as never,
    });

    await usePublishStore.getState().submit();
    const s = usePublishStore.getState();
    expect(s.results.douyin?.ok).toBe(false);
    expect(s.results.douyin?.msg).toBe("账号列表不能为空");
    expect(s.results.wechat?.ok).toBe(true);
  });

  it("setPlatforms 自动为已选平台填充默认账号", () => {
    usePublishStore
      .getState()
      .setPlatforms(["douyin", "wechat"], ACCOUNTS as never);
    const s = usePublishStore.getState();
    expect(s.selectedPlatforms).toEqual(["douyin", "wechat"]);
    expect(s.accountByPlatform.douyin).toBe(1);
    expect(s.accountByPlatform.wechat).toBe(2);
  });

  it("validate 前端校验：缺素材 / 缺平台", () => {
    usePublishStore.setState({ title: "x" });
    const noFile = usePublishStore.getState().validate();
    expect(noFile.some((e) => e.includes("素材"))).toBe(true);

    usePublishStore.setState({
      selectedFile: "a.mp4",
      selectedPlatforms: ["douyin"],
      accountByPlatform: { douyin: null, xiaohongshu: null, wechat: null, kuaishou: null },
    });
    const noAccount = usePublishStore.getState().validate();
    expect(noAccount.some((e) => e.includes("账号"))).toBe(true);
  });

  it("读取旧 number[] 默认定时配置并迁移为 HH:MM string[]", () => {
    localStorage.setItem(
      TIMER_PREF_KEY,
      JSON.stringify({
        timerEnabled: true,
        videosPerDay: 2,
        dailyTimes: [20, 10, 20],
        startDays: 3,
      }),
    );

    expect(loadTimerPref()).toEqual({
      timerEnabled: true,
      videosPerDay: 2,
      dailyTimes: ["10:00", "20:00"],
      startDays: 3,
    });
    expect(JSON.parse(localStorage.getItem(TIMER_PREF_KEY)!).dailyTimes).toEqual([
      "10:00",
      "20:00",
    ]);
  });

  it("默认定时配置新写入只保存 string[]，保留分钟", () => {
    usePublishStore.getState().setTimerPref({
      timerEnabled: true,
      videosPerDay: 2,
      dailyTimes: ["14:30", "09:05"],
      startDays: 1,
    });
    const stored = JSON.parse(localStorage.getItem(TIMER_PREF_KEY)!);
    expect(stored.dailyTimes).toEqual(["09:05", "14:30"]);
    expect(stored.dailyTimes.every((value: unknown) => typeof value === "string")).toBe(true);
  });
});
