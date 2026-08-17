import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialAccountsState, mapDaoAccount, useAccountsStore } from "./accounts";
import { useDaemonStore } from "./daemon";
import type { DaoUserInfo } from "../api/types";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

const ROW_DOUYIN: DaoUserInfo = { id: 1, type: 3, filePath: "a.json", userName: "抖音一号", status: 1 };
const ROW_XHS: DaoUserInfo = { id: 2, type: 1, filePath: "b.json", userName: "小红书", status: 1 };
const ROW_WECHAT: DaoUserInfo = { id: 3, type: 2, filePath: "c.json", userName: "视频号", status: 0 };

describe("mapDaoAccount（官方行 -> 展示模型）", () => {
  it("映射 platform / name / cookie 字段", () => {
    const a = mapDaoAccount(ROW_XHS);
    expect(a.id).toBe(2);
    expect(a.platform).toBe("xiaohongshu");
    expect(a.typeNum).toBe(1);
    expect(a.name).toBe("小红书");
    expect(a.cookieFile).toBe("b.json");
    expect(a.cookieValid).toBe(true);
    expect(a.status).toBe(1);
  });

  it("status=0 时 cookieValid 为 false", () => {
    const a = mapDaoAccount(ROW_WECHAT);
    expect(a.cookieValid).toBe(false);
    expect(a.status).toBe(0);
    expect(a.platform).toBe("wechat");
  });

  it("kuaishou 类型映射", () => {
    const a = mapDaoAccount({ id: 4, type: 4, filePath: "d.json", userName: "快手", status: 1 });
    expect(a.platform).toBe("kuaishou");
  });
});

describe("accounts store（官方账号管理）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    useAccountsStore.setState(initialAccountsState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockRows = {
    code: 200,
    msg: null,
    data: [
      [1, 3, "a.json", "抖音一号", 1],
      [2, 1, "b.json", "小红书", 1],
      [3, 2, "c.json", "视频号", 0],
    ],
  };

  it("fetchAccounts 成功 -> 合并 getAccounts 与 getValidAccounts 的 cookie 有效性", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/getValidAccounts")) {
        // 校验后：抖音/小红书有效，视频号失效
        return jsonResponse({
          code: 200,
          msg: null,
          data: [
            [1, 3, "a.json", "抖音一号", 1],
            [2, 1, "b.json", "小红书", 1],
            [3, 2, "c.json", "视频号", 0],
          ],
        });
      }
      return jsonResponse(mockRows);
    });
    vi.stubGlobal("fetch", fetchMock);

    await useAccountsStore.getState().fetchAccounts();

    const s = useAccountsStore.getState();
    expect(s.accounts).toHaveLength(3);
    expect(s.accounts[0].name).toBe("抖音一号");
    expect(s.accounts[0].cookieValid).toBe(true);
    expect(s.accounts[2].cookieValid).toBe(false);
    expect(s.validAccountIds.has(2)).toBe(true);
    expect(s.error).toBe("");
    // 两家官方接口各请求一次
    const urls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(urls.some((u) => u.endsWith("/getAccounts"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/getValidAccounts"))).toBe(true);
  });

  it("fetchAccounts 失败 -> 记录 error 且列表为空", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: 500, msg: "db 错误", data: null }, false, 500)),
    );

    await useAccountsStore.getState().fetchAccounts();

    expect(useAccountsStore.getState().accounts).toHaveLength(0);
    expect(useAccountsStore.getState().error).toContain("db 错误");
  });

  it("refetchValidAccounts 更新 cookie 有效态", async () => {
    useAccountsStore.setState({
      accounts: [mapDaoAccount(ROW_WECHAT)],
      validAccountIds: new Set(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 200, msg: null, data: [[3, 2, "c.json", "视频号", 1]] }),
      ),
    );

    await useAccountsStore.getState().refetchValidAccounts();

    expect(useAccountsStore.getState().accounts[0].cookieValid).toBe(true);
    expect(useAccountsStore.getState().validAccountIds.has(3)).toBe(true);
  });

  it("removeAccount 成功 -> 本地移除（官方 /deleteAccount）", async () => {
    useAccountsStore.setState({
      accounts: [mapDaoAccount(ROW_DOUYIN)],
      validAccountIds: new Set([1]),
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: "deleted", data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useAccountsStore.getState().removeAccount(1);

    expect((fetchMock.mock.calls[0][0] as string).endsWith("/deleteAccount?id=1")).toBe(true);
    expect(useAccountsStore.getState().accounts).toHaveLength(0);
    expect(useAccountsStore.getState().validAccountIds.size).toBe(0);
  });

  it("removeAccount 失败 -> 抛出错误且保留列表", async () => {
    useAccountsStore.setState({ accounts: [mapDaoAccount(ROW_DOUYIN)] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: 404, msg: "account not found", data: null }, false, 404)),
    );

    await expect(useAccountsStore.getState().removeAccount(1)).rejects.toThrow("account not found");
    expect(useAccountsStore.getState().accounts).toHaveLength(1);
  });
});