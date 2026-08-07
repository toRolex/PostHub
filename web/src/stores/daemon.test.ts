import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useDaemonStore } from "./daemon";

describe("daemon store（守护进程健康检查）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("健康响应 -> connected=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.1.0", port: 8756 }),
      }),
    );

    const store = useDaemonStore();
    await store.checkHealth();

    expect(store.connected).toBe(true);
    expect(store.health?.status).toBe("ok");
    expect(store.health?.version).toBe("0.1.0");
    expect(store.error).toBe("");
  });

  it("请求失败 -> connected=false 且记录 error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const store = useDaemonStore();
    await store.checkHealth();

    expect(store.connected).toBe(false);
    expect(store.error).toBe("connection refused");
  });

  it("HTTP 非 2xx -> connected=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const store = useDaemonStore();
    await store.checkHealth();

    expect(store.connected).toBe(false);
  });

  it("轮询间隔可配置且默认 5s", () => {
    const store = useDaemonStore();
    expect(store.pollIntervalMs).toBe(5000);
    store.pollIntervalMs = 2000;
    expect(store.pollIntervalMs).toBe(2000);
  });
});
