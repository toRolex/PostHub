import { describe, expect, it } from "vitest";

import { buildBatchItemRefs, keyOf, parseKey } from "./batch";
import type { BatchItem } from "./batch";

function makeItem(patch: Partial<BatchItem> = {}): BatchItem {
  return {
    filePath: "a.mp4",
    title: "标题",
    caption: "",
    tags: "",
    accountIdsByPlatform: { douyin: ["d1.json"] },
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
        accountIdsByPlatform: { douyin: ["d1.json", "d2.json"], wechat: [] },
      }),
      makeItem({
        filePath: "v2.mp4",
        mode: "timer",
        startDays: 1,
        timeOfDay: "09:00",
        accountIdsByPlatform: { xiaohongshu: ["x1.json"] },
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
