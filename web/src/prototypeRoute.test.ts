import { describe, expect, it } from "vitest";

import { prototypeExitUrl, resolvePrototype } from "./prototypeRoute";

describe("开发原型 URL 分派", () => {
  it.each([
    ["?prototype=time-picker", "time-picker"],
    ["?prototype=batch-run&variant=C", "batch-run"],
  ] as const)("DEV 下识别 %s", (search, expected) => {
    expect(resolvePrototype(search, true)).toBe(expected);
  });

  it.each([
    ["", true],
    ["?prototype=unknown", true],
    ["?prototype=time-picker", false],
  ] as const)(
    "正式构建或未知参数回到正式应用：%s",
    (search, isDev) => {
      expect(resolvePrototype(search, isDev)).toBeNull();
    },
  );

  it("退出时删除所有原型参数并保留其他查询参数", () => {
    expect(
      prototypeExitUrl(
        "http://localhost:5173/?prototype=batch-run&variant=C&runId=run-099&debug=1",
      ),
    ).toBe("http://localhost:5173/?debug=1");
  });
});
