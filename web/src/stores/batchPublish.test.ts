import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialBatchPublishState,
  selectWechatScheduledCount,
  useBatchPublishStore,
} from "./batchPublish";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("batchPublish store（矩阵批量 → 官方 /postVideoBatch）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
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

  it("旧接口字段（title/tags/selectedFiles/accountIdsByPlatform/batchResult）已从 state 移除", () => {
    // #39 清理后，新 store 不再暴露旧字段（适配层删除）。
    const s = useBatchPublishStore.getState();
    expect((s as unknown as Record<string, unknown>).title).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).tags).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).selectedFiles).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).accountIdsByPlatform).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).batchResult).toBeUndefined();
  });
});

/* ──────────── #40 selectWechatScheduledCount（视频号累计定时任务数） ──────────── */

function mkWechatItem(over: Partial<{
  filePath: string;
  mode: "immediate" | "timer";
  wechat: string[];
}>): import("../types/batch").BatchItem {
  return {
    filePath: over.filePath ?? "a.mp4",
    title: "t",
    caption: "",
    tags: "",
    accountIdsByPlatform: { wechat: over.wechat ?? [] },
    mode: over.mode ?? "immediate",
  };
}

describe("selectWechatScheduledCount（视频号累计定时任务计数）", () => {
  it("items 为空 → 返回 0", () => {
    expect(selectWechatScheduledCount([], "w.json")).toBe(0);
  });

  it("单 item 单账号 + timer → 返回 1", () => {
    const items = [mkWechatItem({ mode: "timer", wechat: ["w.json"] })];
    expect(selectWechatScheduledCount(items, "w.json")).toBe(1);
  });

  it("单 item 多账号 + timer（账号 A） → 仅计 1（A 一次；不重复累加同 item 多账号）", () => {
    const items = [mkWechatItem({ mode: "timer", wechat: ["w_a.json", "w_b.json"] })];
    expect(selectWechatScheduledCount(items, "w_a.json")).toBe(1);
    expect(selectWechatScheduledCount(items, "w_b.json")).toBe(1);
  });

  it("多 item 同账号 + timer → 累算 N 条", () => {
    const items = [
      mkWechatItem({ filePath: "a.mp4", mode: "timer", wechat: ["w.json"] }),
      mkWechatItem({ filePath: "b.mp4", mode: "timer", wechat: ["w.json"] }),
      mkWechatItem({ filePath: "c.mp4", mode: "timer", wechat: ["w.json"] }),
    ];
    expect(selectWechatScheduledCount(items, "w.json")).toBe(3);
  });

  it("mode='immediate' → 不计入（即便勾了该视频号账号）", () => {
    const items = [mkWechatItem({ mode: "immediate", wechat: ["w.json"] })];
    expect(selectWechatScheduledCount(items, "w.json")).toBe(0);
  });

  it("mode='timer' 但未勾视频号 → 不计入", () => {
    const items = [
      mkWechatItem({ mode: "timer", wechat: [] }),
      mkWechatItem({ mode: "timer", wechat: ["w_other.json"] }),
    ];
    expect(selectWechatScheduledCount(items, "w.json")).toBe(0);
  });

  it("混合模式 + 跨账号 → 仅统计该账号的 timer 项", () => {
    const items = [
      mkWechatItem({ filePath: "a.mp4", mode: "timer", wechat: ["w_a.json"] }),
      mkWechatItem({ filePath: "b.mp4", mode: "immediate", wechat: ["w_a.json"] }),
      mkWechatItem({ filePath: "c.mp4", mode: "timer", wechat: ["w_b.json"] }),
    ];
    expect(selectWechatScheduledCount(items, "w_a.json")).toBe(1);
    expect(selectWechatScheduledCount(items, "w_b.json")).toBe(1);
  });
});