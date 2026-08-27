import { describe, expect, it } from "vitest";

import {
  buildBatchItemRefs,
  keyOf,
  parseKey,
  validateBatch,
  wechatScheduledCountsByCookie,
} from "./batch";
import type { BatchItem } from "./batch";

function makeItem(patch: Partial<BatchItem> = {}): BatchItem {
  return {
    filePath: "a.mp4",
    title: "标题",
    caption: "",
    tags: "",
    accountCookiesByPlatform: { douyin: ["d1.json"] },
    mode: "immediate",
    ...patch,
  };
}

describe("keyOf", () => {
  it("filePath + '|' + cookie 拼接，不 escape", () => {
    expect(keyOf("video_x.mp4", "w_a.json")).toBe("video_x.mp4|w_a.json");
  });
});

describe("parseKey", () => {
  it("常规 key 解析出 filePath 与 cookie", () => {
    expect(parseKey("video_x.mp4|w_a.json")).toEqual({
      filePath: "video_x.mp4",
      cookie: "w_a.json",
    });
  });

  it("filePath 含 '|' 时按最后一个分隔符解析（防御）", () => {
    expect(parseKey("my|video.mp4|d1.json")).toEqual({
      filePath: "my|video.mp4",
      cookie: "d1.json",
    });
  });

  it("keyOf 与 parseKey 往返一致", () => {
    const k = keyOf("some/path/v.mp4", "c.json");
    expect(parseKey(k)).toEqual({ filePath: "some/path/v.mp4", cookie: "c.json" });
  });
});

describe("buildBatchItemRefs", () => {
  it("每 (item, platform, cookie) 展开为三元组，跳过空账号数组", () => {
    const items = [
      makeItem({
        filePath: "v1.mp4",
        accountCookiesByPlatform: { douyin: ["d1.json", "d2.json"], wechat: [] },
      }),
      makeItem({
        filePath: "v2.mp4",
        mode: "timer",
        startDays: 1,
        timeOfDay: "09:00",
        accountCookiesByPlatform: { xiaohongshu: ["x1.json"] },
      }),
    ];
    const refs = buildBatchItemRefs(items);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toEqual({ item: items[0], platform: "douyin", cookie: "d1.json" });
    expect(refs[1]).toEqual({ item: items[0], platform: "douyin", cookie: "d2.json" });
    expect(refs[2]).toEqual({ item: items[1], platform: "xiaohongshu", cookie: "x1.json" });
  });

  it("item 引用保持同一对象（非拷贝），便于上游取 mode/timeOfDay 等字段", () => {
    const item = makeItem();
    const refs = buildBatchItemRefs([item]);
    expect(refs[0].item).toBe(item);
  });
});

describe("validateBatch（结构化 ValidationError，issue #57）", () => {
  it("items 为空 → 单条整批错误（row=0，无 filePath）", () => {
    const errors = validateBatch([], []);
    expect(errors).toEqual([{ row: 0, filePath: "", msg: "请至少添加一条视频" }]);
  });

  it("合法批次 → 无错误", () => {
    const errors = validateBatch(
      [makeItem({ title: "t", accountCookiesByPlatform: { douyin: ["d.json"] } })],
      [],
    );
    expect(errors).toEqual([]);
  });

  it("标题为空 → 错误带 row 与 filePath", () => {
    const errors = validateBatch([makeItem({ filePath: "v1.mp4", title: "  " })], []);
    expect(errors).toEqual([
      { row: 1, filePath: "v1.mp4", msg: "标题不能为空" },
    ]);
  });

  it("未勾账号 → 错误带 row 与 filePath", () => {
    const errors = validateBatch(
      [makeItem({ filePath: "v2.mp4", accountCookiesByPlatform: {} })],
      [],
    );
    expect(errors).toEqual([
      { row: 1, filePath: "v2.mp4", msg: "请至少选择一个平台的账号" },
    ]);
  });

  it("timer 未从 dailyTimes 池挑时刻 → 错误", () => {
    const errors = validateBatch(
      [
        makeItem({
          filePath: "v3.mp4",
          mode: "timer",
          startDays: 0,
          timeOfDay: "09:00",
        }),
      ],
      ["10:00"],
    );
    expect(errors).toEqual([
      {
        row: 1,
        filePath: "v3.mp4",
        msg: "定时模式必须从顶部时刻表挑 1 个时刻（timeOfDay）",
      },
    ]);
  });

  it("timer startDays 缺失、非整数或为负 → 错误", () => {
    const errors = validateBatch(
      [
        makeItem({
          filePath: "v4.mp4",
          mode: "timer",
          timeOfDay: "10:00",
          startDays: undefined,
        }),
        makeItem({
          filePath: "v5.mp4",
          mode: "timer",
          timeOfDay: "10:00",
          startDays: 1.5,
        }),
        makeItem({
          filePath: "v6.mp4",
          mode: "timer",
          timeOfDay: "10:00",
          startDays: -1,
        }),
      ],
      ["10:00"],
    );
    expect(errors).toEqual([
      { row: 1, filePath: "v4.mp4", msg: "定时模式必须设置起始日 startDays >= 0" },
      { row: 2, filePath: "v5.mp4", msg: "定时模式必须设置起始日 startDays >= 0" },
      { row: 3, filePath: "v6.mp4", msg: "定时模式必须设置起始日 startDays >= 0" },
    ]);
  });

  it("timer timeOfDay 非法 HH:MM → 错误而不是绕过校验", () => {
    const errors = validateBatch(
      [makeItem({ filePath: "v7.mp4", mode: "timer", timeOfDay: "24:30", startDays: 0 })],
      ["24:30"],
    );
    expect(errors).toEqual([
      { row: 0, filePath: "", msg: "每日时刻须为 HH:MM（小时 0-23，分钟 0-59）" },
      {
        row: 1,
        filePath: "v7.mp4",
        msg: "定时模式必须从顶部时刻表挑 1 个时刻（timeOfDay）",
      },
    ]);
  });

  it("多行错误 → row 按 1 起编号，对应各自 filePath", () => {
    const errors = validateBatch(
      [
        makeItem({ filePath: "ok.mp4" }),
        makeItem({ filePath: "bad.mp4", title: "" }),
      ],
      [],
    );
    expect(errors).toEqual([{ row: 2, filePath: "bad.mp4", msg: "标题不能为空" }]);
  });

  it("platformFields 声明非法 → 错误带 filePath，文案与 validatePlatformFields 一致", () => {
    const errors = validateBatch(
      [
        makeItem({
          filePath: "v6.mp4",
          platformFields: { douyin: { declaration: "bogus" as never } },
        }),
      ],
      [],
    );
    expect(errors).toEqual([
      { row: 1, filePath: "v6.mp4", msg: "抖音「自主声明」取值非法：bogus" },
    ]);
  });

  it("platformFields 合法声明 → 不报错", () => {
    const errors = validateBatch(
      [
        makeItem({
          filePath: "v7.mp4",
          accountCookiesByPlatform: { xiaohongshu: ["x.json"] },
          platformFields: { xiaohongshu: { source: "ai_synthesized" } },
        }),
      ],
      [],
    );
    expect(errors).toEqual([]);
  });
});

describe("wechatScheduledCountsByCookie（视频号累计定时任务计数）", () => {
  function mkWechatItem(over: {
    filePath?: string;
    mode?: "immediate" | "timer";
    wechat?: string[];
  }): BatchItem {
    return makeItem({
      filePath: over.filePath ?? "a.mp4",
      accountCookiesByPlatform: { wechat: over.wechat ?? [] },
      mode: over.mode ?? "immediate",
    });
  }

  it("items 为空 → Map 为空", () => {
    expect(wechatScheduledCountsByCookie([]).size).toBe(0);
  });

  it("单 item 单账号 + timer → 该 cookie 计 1", () => {
    const items = [mkWechatItem({ mode: "timer", wechat: ["w.json"] })];
    const map = wechatScheduledCountsByCookie(items);
    expect(map.get("w.json")).toBe(1);
  });

  it("单 item 多账号 + timer → 每个 cookie 各计 1（同一 item 对同一 cookie 不重复累加）", () => {
    const items = [mkWechatItem({ mode: "timer", wechat: ["w_a.json", "w_b.json"] })];
    const map = wechatScheduledCountsByCookie(items);
    expect(map.get("w_a.json")).toBe(1);
    expect(map.get("w_b.json")).toBe(1);
  });

  it("多 item 同账号 + timer → 累算 N 条", () => {
    const items = [
      mkWechatItem({ filePath: "a.mp4", mode: "timer", wechat: ["w.json"] }),
      mkWechatItem({ filePath: "b.mp4", mode: "timer", wechat: ["w.json"] }),
      mkWechatItem({ filePath: "c.mp4", mode: "timer", wechat: ["w.json"] }),
    ];
    expect(wechatScheduledCountsByCookie(items).get("w.json")).toBe(3);
  });

  it("mode='immediate' → 不计入（即便勾了该视频号账号）", () => {
    const items = [mkWechatItem({ mode: "immediate", wechat: ["w.json"] })];
    expect(wechatScheduledCountsByCookie(items).get("w.json")).toBeUndefined();
  });

  it("mode='timer' 但未勾视频号 → 不计入", () => {
    const items = [
      mkWechatItem({ mode: "timer", wechat: [] }),
      mkWechatItem({ mode: "timer", wechat: ["w_other.json"] }),
    ];
    const map = wechatScheduledCountsByCookie(items);
    expect(map.get("w.json")).toBeUndefined();
    expect(map.get("w_other.json")).toBe(1);
  });

  it("混合模式 + 跨账号 → 仅统计各账号的 timer 项", () => {
    const items = [
      mkWechatItem({ filePath: "a.mp4", mode: "timer", wechat: ["w_a.json"] }),
      mkWechatItem({ filePath: "b.mp4", mode: "immediate", wechat: ["w_a.json"] }),
      mkWechatItem({ filePath: "c.mp4", mode: "timer", wechat: ["w_b.json"] }),
    ];
    const map = wechatScheduledCountsByCookie(items);
    expect(map.get("w_a.json")).toBe(1);
    expect(map.get("w_b.json")).toBe(1);
    expect(map.size).toBe(2);
  });
});
