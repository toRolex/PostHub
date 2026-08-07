import { describe, expect, it } from "vitest";

import { decideNotification } from "./notify";

describe("decideNotification（任务状态变化 → 本地通知触发条件）", () => {
  it("pending -> success 触发「发布完成」通知", () => {
    const d = decideNotification("pending", "success", "春日踏青");
    expect(d.shouldNotify).toBe(true);
    expect(d.kind).toBe("success");
    expect(d.title).toContain("完成");
    expect(d.body).toContain("春日踏青");
  });

  it("publishing -> manual 触发「需要人工介入」", () => {
    const d = decideNotification("publishing", "manual", "A");
    expect(d.shouldNotify).toBe(true);
    expect(d.kind).toBe("warning");
    expect(d.title).toContain("人工");
  });

  it("publishing -> needs_relogin 触发「需要重新登录」", () => {
    const d = decideNotification("publishing", "needs_relogin", "A");
    expect(d.shouldNotify).toBe(true);
    expect(d.title).toContain("重新登录");
  });

  it("publishing -> failed 触发「发布失败」", () => {
    const d = decideNotification("publishing", "failed", "A");
    expect(d.shouldNotify).toBe(true);
    expect(d.kind).toBe("error");
    expect(d.title).toContain("失败");
  });

  it("状态未变化不触发通知", () => {
    expect(decideNotification("success", "success", "A").shouldNotify).toBe(false);
    expect(decideNotification("pending", "pending", "A").shouldNotify).toBe(false);
  });

  it("首次观测（prev 为 null）不作为变更触发", () => {
    expect(decideNotification(null, "success", "A").shouldNotify).toBe(false);
    expect(decideNotification(null, "manual", "A").shouldNotify).toBe(false);
  });

  it("pending -> publishing（进行中）不触发通知", () => {
    expect(decideNotification("pending", "publishing", "A").shouldNotify).toBe(false);
  });

  it("partial（部分成功）不触发通知", () => {
    expect(decideNotification("pending", "partial", "A").shouldNotify).toBe(false);
  });
});
