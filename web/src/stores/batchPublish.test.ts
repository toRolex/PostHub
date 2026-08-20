import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialBatchPublishState,
  useBatchPublishStore,
} from "./batchPublish";
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

describe("batchPublish store（矩阵批量 → 官方 /postVideoBatch）", () => {
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

  /* ──────────── 新 store：items / dailyTimes 状态机 ──────────── */

  it("addItem：推入一条 item；items 长度 +1", () => {
    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "标题 A",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    const s = useBatchPublishStore.getState();
    expect(s.items).toHaveLength(1);
    expect(s.items[0].filePath).toBe("a.mp4");
  });

  it("removeItem：按 filePath 移除；多条时仅移一条", () => {
    const { addItem, removeItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "A",
      caption: "",
      tags: "",
      accountIdsByPlatform: {},
      mode: "immediate",
    });
    addItem({
      filePath: "b.mp4",
      title: "B",
      caption: "",
      tags: "",
      accountIdsByPlatform: {},
      mode: "immediate",
    });
    removeItem("a.mp4");
    expect(useBatchPublishStore.getState().items.map((i) => i.filePath)).toEqual([
      "b.mp4",
    ]);
  });

  it("updateItem：按 filePath 局部 patch；不影响其它字段", () => {
    const { addItem, updateItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "原标题",
      caption: "原描述",
      tags: "tag",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    updateItem("a.mp4", { title: "新标题" });
    const item = useBatchPublishStore.getState().items[0];
    expect(item.title).toBe("新标题");
    expect(item.caption).toBe("原描述");
    expect(item.mode).toBe("immediate");
  });

  it("setItemMode：从 immediate 切到 timer 必须补齐 startDays + timeOfDay", () => {
    const { addItem, setItemMode } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    setItemMode("a.mp4", "timer");
    const item = useBatchPublishStore.getState().items[0];
    expect(item.mode).toBe("timer");
    expect(item.startDays).toBe(0); // 默认 0 = 明天起
    expect(item.timeOfDay).toBe(""); // 默认空（用户后续从 dailyTimes 挑）
  });

  it("setItemTimeOfDay：写入 HH:MM；不影响 mode 与 startDays", () => {
    const { addItem, setItemMode, setItemTimeOfDay } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    setItemMode("a.mp4", "timer");
    setItemTimeOfDay("a.mp4", "10:00");
    const item = useBatchPublishStore.getState().items[0];
    expect(item.timeOfDay).toBe("10:00");
    expect(item.startDays).toBe(0);
  });

  it("addDailyTime / removeDailyTime：dailyTimes 池增减", () => {
    const { addDailyTime, removeDailyTime } = useBatchPublishStore.getState();
    addDailyTime("10:00");
    addDailyTime("14:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["10:00", "14:00"]);
    removeDailyTime("10:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["14:00"]);
  });

  it("addDailyTime：重复加同一时刻去重", () => {
    const { addDailyTime } = useBatchPublishStore.getState();
    addDailyTime("10:00");
    addDailyTime("10:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["10:00"]);
  });

  it("validate：items 为空 -> '请至少添加一条视频' 错误", () => {
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("视频"))).toBe(true);
  });

  it("validate：item 缺标题 -> '标题不能为空' 错误", () => {
    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("标题"))).toBe(true);
  });

  it("validate：item 没勾账号 -> '请至少选择一个平台的账号'", () => {
    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: {},
      mode: "immediate",
    });
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("账号"))).toBe(true);
  });

  it("validate：mode='timer' 但 timeOfDay 未从 dailyTimes 挑 -> 错误", () => {
    const { addItem, addDailyTime, setItemMode } = useBatchPublishStore.getState();
    addDailyTime("10:00");
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    setItemMode("a.mp4", "timer"); // startDays=0 默认，但 timeOfDay 为空
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("时刻") || e.includes("timeOfDay"))).toBe(true);
  });

  /* ──────────── submit：核心矩阵展开 ──────────── */

  it("submit 成功：每视频×每账号展开，请求体严格对应；itemResults 按 item 索引", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "标题 A",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json", "douyin_b.json"] },
      mode: "immediate",
    });

    await useBatchPublishStore.getState().submit();

    // 一次 POST /postVideoBatch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // 一个 item × 2 账号 = 2 个 postVideo 项
    expect(body).toHaveLength(2);
    expect(body[0].fileList).toEqual(["a.mp4"]);
    expect(body[0].accountList).toEqual(["douyin_a.json"]);
    expect(body[1].accountList).toEqual(["douyin_b.json"]);
    expect(body[0].enableTimer).toBe(false);

    // itemResults 按 item 索引（不是按 Platform）
    const s = useBatchPublishStore.getState();
    expect(s.itemResults).toHaveLength(2);
    expect(s.itemResults![0]).toMatchObject({
      fileName: "a.mp4",
      platform: "douyin",
      mode: "immediate",
      ok: true,
      msg: "批量发布任务已提交",
    });
    expect(s.itemResults![1].ok).toBe(true);
  });

  it("**result 键冲突回归**：矩阵模式下同平台多账号展开，每个 item 独立反馈", async () => {
    // 旧实现以 Platform 作 key，矩阵模式下 2 账号会被覆盖为 1 项（丢反馈）。
    // 新实现以 item index 作 key，每账号一项独立反馈。
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json", "douyin_b.json"] },
      mode: "immediate",
    });

    await useBatchPublishStore.getState().submit();

    const s = useBatchPublishStore.getState();
    expect(s.itemResults).toHaveLength(2);
    // 两个 itemResult 不互相覆盖
    expect(s.itemResults!.map((r) => r.itemKey).sort()).toEqual([
      "a.mp4|douyin_a.json",
      "a.mp4|douyin_b.json",
    ]);
    expect(s.itemResults!.every((r) => r.ok)).toBe(true);
  });

  it("submit 失败（请求级错误）-> 每项独立反馈失败 + 抛错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 400, msg: "Expected a JSON array", data: null }, false, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });

    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      "Expected a JSON array",
    );
    const s = useBatchPublishStore.getState();
    expect(s.itemResults).toHaveLength(1);
    expect(s.itemResults![0].ok).toBe(false);
    expect(s.itemResults![0].msg).toBe("Expected a JSON array");
  });

  it("submit 校验失败 -> 抛错且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      /视频/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("混合模式提交：immediate + timer 共存", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem, addDailyTime, setItemMode, setItemTimeOfDay } =
      useBatchPublishStore.getState();
    addDailyTime("10:00");

    addItem({
      filePath: "a.mp4",
      title: "立即",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    addItem({
      filePath: "b.mp4",
      title: "定时",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_b.json"] },
      mode: "immediate",
    });
    setItemMode("b.mp4", "timer");
    setItemTimeOfDay("b.mp4", "10:00");

    await useBatchPublishStore.getState().submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toHaveLength(2);
    expect(body[0].enableTimer).toBe(false);
    expect("videosPerDay" in body[0]).toBe(false);
    expect(body[1].enableTimer).toBe(true);
    expect(body[1].videosPerDay).toBe(1);
    expect(body[1].dailyTimes).toEqual([10]);
    expect(body[1].startDays).toBe(0);
  });

  it("reset：清空 items / dailyTimes / itemResults / submitting", () => {
    const { addItem, addDailyTime, reset } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountIdsByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    addDailyTime("10:00");
    reset();
    const s = useBatchPublishStore.getState();
    expect(s.items).toHaveLength(0);
    expect(s.dailyTimes).toHaveLength(0);
    expect(s.itemResults).toBeNull();
    expect(s.submitting).toBe(false);
  });

  /* ──────────── 旧接口适配层（#02 切换时统一删除） ──────────── */

  it("适配层：setForm(title/tags) 写入共享字段", () => {
    const { setForm } = useBatchPublishStore.getState();
    setForm({ title: "旧组件标题", tags: "tag1 tag2" });
    expect(useBatchPublishStore.getState().title).toBe("旧组件标题");
    expect(useBatchPublishStore.getState().tags).toBe("tag1 tag2");
  });

  it("适配层：setSelectedFiles -> 同步 push items（每文件一个 item）", () => {
    const { setSelectedFiles } = useBatchPublishStore.getState();
    setSelectedFiles(["a.mp4", "b.mp4"]);
    const s = useBatchPublishStore.getState();
    expect(s.selectedFiles).toEqual(["a.mp4", "b.mp4"]);
    // 适配层把 selectedFiles 同步到 items（每个 file 一个 item）
    expect(s.items.map((i) => i.filePath)).toEqual(["a.mp4", "b.mp4"]);
  });

  it("适配层：setPlatformAccountIds(平台, ids) -> 把 id 映射为 cookie 文件名写入对应 item", () => {
    const { setSelectedFiles, setPlatformAccountIds } =
      useBatchPublishStore.getState();
    setSelectedFiles(["a.mp4"]);
    setPlatformAccountIds("douyin", [1, 2]);
    const item = useBatchPublishStore.getState().items[0];
    expect(item.accountIdsByPlatform.douyin).toEqual([
      "douyin_a.json",
      "douyin_b.json",
    ]);
  });

  it("适配层：validate(submit) 校验通过后走 buildBatchItemsFromMatrix（旧组件调用链）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { setForm, setSelectedFiles, setPlatformAccountIds } =
      useBatchPublishStore.getState();
    setForm({ title: "旧标题", tags: "tag" });
    setSelectedFiles(["a.mp4"]);
    setPlatformAccountIds("douyin", [1]);

    await useBatchPublishStore.getState().submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // 旧组件一条 selectedFiles × 一个平台 = 1 项
    expect(body).toHaveLength(1);
    expect(body[0].fileList).toEqual(["a.mp4"]);
    expect(body[0].accountList).toEqual(["douyin_a.json"]);
    expect(body[0].title).toBe("旧标题");
    expect(body[0].tags).toEqual(["tag"]);
  });

  it("适配层：reset 同时清空新旧两套状态", () => {
    const { setForm, setSelectedFiles, setPlatformAccountIds, reset } =
      useBatchPublishStore.getState();
    setForm({ title: "t", tags: "tag" });
    setSelectedFiles(["a.mp4"]);
    setPlatformAccountIds("douyin", [1]);
    reset();
    const s = useBatchPublishStore.getState();
    expect(s.title).toBe("");
    expect(s.tags).toBe("");
    expect(s.selectedFiles).toEqual([]);
    expect(s.accountIdsByPlatform).toEqual({
      douyin: [],
      xiaohongshu: [],
      wechat: [],
      kuaishou: [],
    });
    expect(s.items).toEqual([]);
  });
});