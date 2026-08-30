import { describe, expect, it } from "vitest";

import { parseTags } from "./tags";

describe("parseTags", () => {
  it("空串 / 空白串返回空数组", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("多 tag：空白、中英文逗号混用拆分，去 # 前缀", () => {
    expect(parseTags(" 春天 旅行 #美食，摄影,#旅行 ")).toEqual([
      "春天",
      "旅行",
      "美食",
      "摄影",
      "旅行",
    ]);
  });

  it("分隔符 edge case：连续分隔符与纯 # 片段不产出空项", () => {
    expect(parseTags("a,,，  b")).toEqual(["a", "b"]);
    expect(parseTags("##")).toEqual([]);
    expect(parseTags("###美食")).toEqual(["美食"]);
  });
});
