import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialDaemonState, useDaemonStore } from "./daemon";

describe("daemon store（官方后端探活）", () => {
  beforeEach(() => {
    useDaemonStore.setState(initialDaemonState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("探活 /getAccounts 2xx -> connected=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    await useDaemonStore.getState().checkHealth();

    const s = useDaemonStore.getState();
    expect(s.connected).toBe(true);
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