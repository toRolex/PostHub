import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialAccountsState, useAccountsStore } from "./accounts";
import { useDaemonStore } from "./daemon";
import type { Account } from "../api/types";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const ACCOUNT_A: Account = {
  id: 1,
  platform: "douyin",
  name: "抖音一号",
  profile_dir: "/p",
  cdp_port: 9222,
  chrome_path: null,
  status: "active",
  last_login_at: null,
  last_publish_at: null,
  created_at: "",
  updated_at: "",
};

describe("accounts store（账号管理）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useAccountsStore.setState(initialAccountsState);
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

    await useAccountsStore.getState().fetchAccounts();

    const s = useAccountsStore.getState();
    expect(s.accounts).toHaveLength(2);
    expect(s.accounts[0].platform).toBe("douyin");
    expect(s.error).toBe("");
  });

  it("fetchAccounts 失败 -> 记录 error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    await useAccountsStore.getState().fetchAccounts();

    expect(useAccountsStore.getState().accounts).toHaveLength(0);
    expect(useAccountsStore.getState().error).toContain("500");
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

    const created = await useAccountsStore
      .getState()
      .createAccount({ platform: "xiaohongshu", name: "小红书" });

    expect(created.id).toBe(3);
    expect(useAccountsStore.getState().accounts).toContainEqual(account);
    expect(useAccountsStore.getState().error).toBe("");
  });

  it("createAccount 失败 -> 抛出错误且不追加", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "platform 非法" }, false, 400)),
    );

    await expect(
      useAccountsStore.getState().createAccount({ platform: "douyin" }),
    ).rejects.toThrow();

    expect(useAccountsStore.getState().accounts).toHaveLength(0);
    expect(useAccountsStore.getState().error).toContain("platform 非法");
  });

  it("removeAccount 成功 -> 从列表移除", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({
          accounts: [{ id: 1, platform: "douyin", name: "抖音一号", cdp_port: 9222, status: "active" }],
        });
      }),
    );

    await useAccountsStore.getState().fetchAccounts();
    expect(useAccountsStore.getState().accounts).toHaveLength(1);

    await useAccountsStore.getState().removeAccount(1);

    expect(useAccountsStore.getState().accounts).toHaveLength(0);
  });

  it("removeAccount 失败 -> 抛出错误且保留列表", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "账号不存在" }, false, 404)),
    );

    await useAccountsStore.getState().fetchAccounts().catch(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "账号不存在" }, false, 404)),
    );

    await expect(useAccountsStore.getState().removeAccount(1)).rejects.toThrow();
    expect(useAccountsStore.getState().error).toContain("账号不存在");
  });

  it("通过 daemon store 的 url 请求", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ accounts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await useAccountsStore.getState().fetchAccounts();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9999/accounts");
  });

  it("relogin 调用 POST /accounts/{id}/relogin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await useAccountsStore.getState().relogin(7);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/accounts/7/relogin",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("relogin 返回 launch_warning 时透传", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, launch_warning: "未找到 Chrome" }),
      ),
    );

    const result = await useAccountsStore.getState().relogin(1);

    expect(result.launch_warning).toBe("未找到 Chrome");
  });

  it("setStatus 调用 POST /accounts/{id}/status 并更新本地状态", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ accounts: [] });
      });
    vi.stubGlobal("fetch", fetchMock);

    useAccountsStore.setState({
      accounts: [{ ...ACCOUNT_A, id: 3, status: "needs_relogin" }],
    });

    await useAccountsStore.getState().setStatus(3, "active");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/accounts/3/status",
      expect.objectContaining({ method: "POST" }),
    );
    expect(useAccountsStore.getState().accounts[0].status).toBe("active");
  });

  it("setStatus 失败 -> 抛出错误且本地状态不变", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "status 非法" }, false, 400)),
    );

    useAccountsStore.setState({
      accounts: [{ ...ACCOUNT_A, id: 3, status: "needs_relogin" }],
    });

    await expect(
      useAccountsStore.getState().setStatus(3, "active"),
    ).rejects.toThrow("status 非法");
    expect(useAccountsStore.getState().accounts[0].status).toBe("needs_relogin");
  });
});
