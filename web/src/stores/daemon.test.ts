import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialDaemonState, useDaemonStore } from "./daemon";

describe("daemon store（守护进程健康检查）", () => {
  beforeEach(() => {
    useDaemonStore.setState(initialDaemonState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("健康响应 -> connected=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok", version: "0.1.0", port: 5409 }),
      }),
    );

    await useDaemonStore.getState().checkHealth();

    const s = useDaemonStore.getState();
    expect(s.connected).toBe(true);
    expect(s.health?.status).toBe("ok");
    expect(s.health?.version).toBe("0.1.0");
    expect(s.error).toBe("");
  });

  it("请求失败 -> connected=false 且记录 error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    await useDaemonStore.getState().checkHealth();

    expect(useDaemonStore.getState().connected).toBe(false);
    expect(useDaemonStore.getState().error).toBe("connection refused");
  });

  it("HTTP 非 2xx -> connected=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await useDaemonStore.getState().checkHealth();

    expect(useDaemonStore.getState().connected).toBe(false);
  });

  it("轮询间隔可配置且默认 5s", () => {
    expect(useDaemonStore.getState().pollIntervalMs).toBe(5000);
    useDaemonStore.setState({ pollIntervalMs: 2000 });
    expect(useDaemonStore.getState().pollIntervalMs).toBe(2000);
  });
});
