import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { usePlatformStore, type PlatformConstraint } from "./platform";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const SAMPLE: PlatformConstraint[] = [
  {
    platform: "douyin",
    label: "抖音",
    min_lead_time_seconds: 7200,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 1209600,
    max_scheduled_per_day: null,
    cover_required: true,
    auto_cover_first_frame: false,
  },
  {
    platform: "xiaohongshu",
    label: "小红书",
    min_lead_time_seconds: 3600,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 604800,
    max_scheduled_per_day: null,
    cover_required: false,
    auto_cover_first_frame: true,
  },
  {
    platform: "wechat",
    label: "微信视频号",
    min_lead_time_seconds: 7200,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 2592000,
    max_scheduled_per_day: 5,
    cover_required: false,
    auto_cover_first_frame: true,
  },
];

describe("platform store（平台约束注册表）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchConstraints 成功 -> 按平台填充并清空 error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ constraints: SAMPLE })),
    );

    const store = usePlatformStore();
    await store.fetchConstraints();

    expect(store.constraints.douyin!.min_lead_time_seconds).toBe(7200);
    expect(store.constraints.xiaohongshu!.min_lead_time_seconds).toBe(3600);
    expect(store.constraints.wechat!.max_scheduled_per_day).toBe(5);
    expect(store.constraints.douyin!.cover_required).toBe(true);
    expect(store.error).toBe("");
  });

  it("fetchConstraints 失败 -> 记录 error 且保持空表", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const store = usePlatformStore();
    await store.fetchConstraints();

    expect(store.constraints).toEqual({});
    expect(store.error).toContain("500");
  });

  it("通过 daemon store 的 url 请求 /platform-constraints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ constraints: SAMPLE }));
    vi.stubGlobal("fetch", fetchMock);

    const daemon = useDaemonStore();
    daemon.url = "http://127.0.0.1:9999";
    const store = usePlatformStore();
    await store.fetchConstraints();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/platform-constraints",
    );
  });
});
