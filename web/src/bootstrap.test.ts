import { describe, expect, it } from "vitest";

import { loadApplicationRoot } from "./bootstrap";

describe("应用 bootstrap 隔离", () => {
  it("prototype 命中时只调用原型 loader", async () => {
    const calls: string[] = [];
    const result = await loadApplicationRoot("time-picker", {
      app: async () => { calls.push("app"); return "app"; },
      timePicker: async () => { calls.push("time-picker"); return "prototype"; },
      batchRun: async () => { calls.push("batch-run"); return "prototype"; },
    });

    expect(result).toBe("prototype");
    expect(calls).toEqual(["time-picker"]);
  });

  it("普通 URL 和未知参数只调用正式 App loader", async () => {
    const calls: string[] = [];
    const loaders = {
      app: async () => { calls.push("app"); return "app"; },
      timePicker: async () => { calls.push("time-picker"); return "prototype"; },
      batchRun: async () => { calls.push("batch-run"); return "prototype"; },
    };

    expect(await loadApplicationRoot(null, loaders)).toBe("app");
    expect(calls).toEqual(["app"]);
  });
});
