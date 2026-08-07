import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useAccountsStore } from "./accounts";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("accounts store（账号管理）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchAccounts 成功 -> 填充列表并清空 error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          accounts: [
            { id: 1, platform: "douyin", name: "抖音一号", cdp_port: 9222, status: "active" },
            { id: 2, platform: "wechat", name: "视频号", cdp_port: 9223, status: "active" },
          ],
        }),
      ),
    );

    const store = useAccountsStore();
    await store.fetchAccounts();

    expect(store.accounts).toHaveLength(2);
    expect(store.accounts[0].platform).toBe("douyin");
    expect(store.error).toBe("");
  });

  it("fetchAccounts 失败 -> 记录 error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const store = useAccountsStore();
    await store.fetchAccounts();

    expect(store.accounts).toHaveLength(0);
    expect(store.error).toContain("500");
  });

  it("createAccount 成功 -> 追加到列表", async () => {
    const account = {
      id: 3,
      platform: "xiaohongshu",
      name: "小红书",
      cdp_port: 9224,
      status: "active",
      profile_dir: "/profiles/xiaohongshu-9224",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ account }, true, 201)));

    const store = useAccountsStore();
    const created = await store.createAccount({ platform: "xiaohongshu", name: "小红书" });

    expect(created.id).toBe(3);
    expect(store.accounts).toContainEqual(account);
    expect(store.error).toBe("");
  });

  it("createAccount 失败 -> 抛出错误且不追加", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "platform 非法" }, false, 400)),
    );

    const store = useAccountsStore();
    await expect(store.createAccount({ platform: "douyin" })).rejects.toThrow();

    expect(store.accounts).toHaveLength(0);
    expect(store.error).toContain("platform 非法");
  });

  it("removeAccount 成功 -> 从列表移除", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          accounts: [
            { id: 1, platform: "douyin", name: "抖音一号", cdp_port: 9222, status: "active" },
          ],
        });
      }),
    );

    const store = useAccountsStore();
    await store.fetchAccounts();
    expect(store.accounts).toHaveLength(1);

    await store.removeAccount(1);

    expect(store.accounts).toHaveLength(0);
  });

  it("removeAccount 失败 -> 抛出错误且保留列表", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "账号不存在" }, false, 404)));

    const store = useAccountsStore();
    await store.fetchAccounts().catch(() => undefined); // 忽略 fetch 失败
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "账号不存在" }, false, 404)),
    );

    await expect(store.removeAccount(1)).rejects.toThrow();
    expect(store.error).toContain("账号不存在");
  });

  it("通过 daemon store 的 url 请求", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accounts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const daemon = useDaemonStore();
    daemon.url = "http://127.0.0.1:9999";
    const store = useAccountsStore();
    await store.fetchAccounts();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9999/accounts");
  });
});
