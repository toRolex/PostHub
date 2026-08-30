import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialBatchPublishState,
  useBatchPublishStore,
} from "./batchPublish";
import { useDaemonStore } from "./daemon";
import { useRunStore, initialRunState } from "./runs";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("batchPublish store（矩阵批量 → /postRuns accepted）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useBatchPublishStore.setState(initialBatchPublishState);
    useRunStore.setState(initialRunState);
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    const s = useBatchPublishStore.getState();
    expect(s.items).toHaveLength(1);
    expect(s.items[0].filePath).toBe("a.mp4");
  });

  it("addItem：相同 filePath 幂等，不重复加入", () => {
    const { addItem } = useBatchPublishStore.getState();
    const item = {
      filePath: "a.mp4",
      title: "A",
      caption: "",
      tags: "",
      accountCookiesByPlatform: {},
      mode: "immediate" as const,
    };
    addItem(item);
    addItem({ ...item, title: "重复 A" });
    expect(useBatchPublishStore.getState().items).toEqual([item]);
  });

  it("removeItem：按 filePath 移除；多条时仅移一条", () => {
    const { addItem, removeItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "A",
      caption: "",
      tags: "",
      accountCookiesByPlatform: {},
      mode: "immediate",
    });
    addItem({
      filePath: "b.mp4",
      title: "B",
      caption: "",
      tags: "",
      accountCookiesByPlatform: {},
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    setItemMode("a.mp4", "timer");
    setItemTimeOfDay("a.mp4", "10:00");
    const item = useBatchPublishStore.getState().items[0];
    expect(item.timeOfDay).toBe("10:00");
    expect(item.startDays).toBe(0);
  });

  it("setItemPlatformField：写入单平台声明；不影响其他字段（issue #43）", () => {
    const { addItem, setItemPlatformField } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { wechat: ["w.json"] },
      mode: "immediate",
    });
    setItemPlatformField("a.mp4", "wechat", { declaration: "no_label" });
    const item = useBatchPublishStore.getState().items[0];
    expect(item.platformFields).toEqual({ wechat: { declaration: "no_label" } });
    expect(item.title).toBe("t");
  });

  it("setItemPlatformField：非法枚举 → validate 失败", () => {
    const { addItem, setItemPlatformField } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { wechat: ["w.json"] },
      mode: "immediate",
    });
    setItemPlatformField(
      "a.mp4",
      "wechat",
      { declaration: "bogus" } as unknown as { declaration: never },
    );
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("视频号"))).toBe(true);
  });

  it("addDailyTime / removeDailyTime：dailyTimes 池增减", () => {
    const { addDailyTime, removeDailyTime } = useBatchPublishStore.getState();
    addDailyTime("10:00");
    addDailyTime("14:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["10:00", "14:00"]);
    removeDailyTime("10:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["14:00"]);
  });

  it("addDailyTime：重复去重、按 HH:MM 排序、非法值不写入", () => {
    const { addDailyTime } = useBatchPublishStore.getState();
    addDailyTime("14:30");
    addDailyTime("09:05");
    addDailyTime("14:30");
    addDailyTime("24:00");
    expect(useBatchPublishStore.getState().dailyTimes).toEqual(["09:05", "14:30"]);
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
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
      accountCookiesByPlatform: {},
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    setItemMode("a.mp4", "timer"); // startDays=0 默认，但 timeOfDay 为空
    const errors = useBatchPublishStore.getState().validate();
    expect(errors.some((e) => e.includes("时刻") || e.includes("timeOfDay"))).toBe(true);
  });

  /* ──────────── submit：核心矩阵展开 ──────────── */

  it("submit 成功：每视频×每账号展开，请求体严格对应；状态只写入 RunStore", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        msg: "已受理",
        data: { runId: "run-many", status: "pending", itemCount: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "标题 A",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_a.json", "douyin_b.json"] },
      mode: "immediate",
    });

    await useBatchPublishStore.getState().submit();

    // 多账号 immediate 只发一次 accepted /postRuns，payload 保留两个 effective 候选项
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/postRuns");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toHaveLength(2);
    expect(body[0].fileList).toEqual(["a.mp4"]);
    expect(body[0].accountList).toEqual(["douyin_a.json"]);
    expect(body[1].accountList).toEqual(["douyin_b.json"]);
    expect(body[0].enableTimer).toBe(false);
    expect(useRunStore.getState().runId).toBe("run-many");

    // accepted 后不合成请求级 item 结果；详情必须来自 RunStore snapshot。
    expect((useBatchPublishStore.getState() as unknown as Record<string, unknown>).itemResults).toBeUndefined();
    expect(useRunStore.getState().summary).toBeNull();
  });

  it("多账号矩阵一次受理，详情不在 batch store 合成", async () => {
    // RunStore 负责 item 事实；batch store 只提交规范化请求。
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        msg: "已受理",
        data: { runId: "run-two", status: "pending", itemCount: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_a.json", "douyin_b.json"] },
      mode: "immediate",
    });

    await useBatchPublishStore.getState().submit();

    expect((useBatchPublishStore.getState() as unknown as Record<string, unknown>).itemResults).toBeUndefined();
    expect(useRunStore.getState().runId).toBe("run-two");
  });

  it("跨提交历史重复取消不创建 run，确认后才允许批量重发", async () => {
    const duplicate = {
      id: 7,
      accountId: 1,
      accountFile: "douyin_a.json",
      accountName: "抖音一号",
      platform: "douyin",
      videoId: "a.mp4",
      videoTitle: "历史视频",
      effectiveScheduledFor: null,
      scheduledFor: null,
      status: "published",
      publishedAt: "2026-08-29 10:00:00",
      runId: "old-run",
      runItemId: "old-item",
      recordedAt: "2026-08-29 10:00:00",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 409,
            msg: "发现已有成功发布记录，请确认是否重新发布",
            data: { kind: "history_duplicate", duplicates: [duplicate] },
          },
          false,
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 409,
            msg: "发现已有成功发布记录，请确认是否重新发布",
            data: { kind: "history_duplicate", duplicates: [duplicate] },
          },
          false,
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          msg: "已受理",
          data: { runId: "new-run", status: "pending", itemCount: 1 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useBatchPublishStore.getState().addItem({
      filePath: "a.mp4",
      title: "标题",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });

    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      "发现已有成功发布记录，请确认是否重新发布",
    );
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useRunStore.getState().runId).toBeNull();

    confirm.mockReturnValue(true);
    await useBatchPublishStore.getState().submit();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useRunStore.getState().runId).toBe("new-run");
  });

  it("409 冲突显示本次未受理并保留已有 run，不写入本地 accepted run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: 409,
            msg: "已有相同视频×账号的运行正在执行",
            data: { existingRunId: "run-existing" },
          },
          false,
          409,
        ),
      ),
    );
    const { addItem } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });

    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      "已有相同视频×账号的运行正在执行",
    );

    expect(useRunStore.getState().runId).toBeNull();
    expect(useRunStore.getState().error).toContain("已有运行 run-existing");
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });

    await expect(useBatchPublishStore.getState().submit()).rejects.toThrow(
      "Expected a JSON array",
    );
    expect((useBatchPublishStore.getState() as unknown as Record<string, unknown>).itemResults).toBeUndefined();
    expect(useRunStore.getState().error).toBe("Expected a JSON array");
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
      jsonResponse({
        code: 200,
        msg: "已受理",
        data: { runId: "run-mixed", status: "pending", itemCount: 2 },
      }),
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
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    addItem({
      filePath: "b.mp4",
      title: "定时",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_b.json"] },
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
    expect(body[1].dailyTimes).toEqual(["10:00"]);
    expect(body[1].startDays).toBe(0);
  });

  it("reset：清空 items / dailyTimes / submitting", () => {
    const { addItem, addDailyTime, reset } = useBatchPublishStore.getState();
    addItem({
      filePath: "a.mp4",
      title: "t",
      caption: "",
      tags: "",
      accountCookiesByPlatform: { douyin: ["douyin_a.json"] },
      mode: "immediate",
    });
    addDailyTime("10:00");
    reset();
    const s = useBatchPublishStore.getState();
    expect(s.items).toHaveLength(0);
    expect(s.dailyTimes).toHaveLength(0);
    expect(s.submitting).toBe(false);
  });

  it("旧接口字段（title/tags/selectedFiles/accountCookiesByPlatform/batchResult）已从 state 移除", () => {
    // #39 清理后，新 store 不再暴露旧字段（适配层删除）。
    const s = useBatchPublishStore.getState();
    expect((s as unknown as Record<string, unknown>).title).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).tags).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).selectedFiles).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).accountCookiesByPlatform).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).batchResult).toBeUndefined();
  });
});
