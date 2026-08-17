import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCookiesStore, rowToCookiedAccount } from "./cookies";
import { useDaemonStore } from "./daemon";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** 官方 user_info 数组行：[id, type, filePath, userName, status] */
const ROW_DOUYIN = [3, 3, "abc.json", "抖音号", 1] as const;
const ROW_XHS = [1, 1, "xhs.json", "小红书号", 0] as const;

describe("cookies store（cookie 导入/导出，官方 seam）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:5409" });
    useCookiesStore.setState({
      accounts: [],
      loading: false,
      validating: false,
      importingId: null,
      error: "",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rowToCookiedAccount 将官方数组行解析为对象", () => {
    expect(rowToCookiedAccount(ROW_DOUYIN)).toEqual({
      id: 3,
      type: 3,
      filePath: "abc.json",
      userName: "抖音号",
      status: 1,
    });
  });

  it("fetchAccounts 调 GET /getAccounts 并解析数组行", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        msg: null,
        data: [ROW_DOUYIN, ROW_XHS],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useCookiesStore.getState().fetchAccounts();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5409/getAccounts", undefined);
    const s = useCookiesStore.getState();
    expect(s.accounts).toHaveLength(2);
    expect(s.accounts[0].filePath).toBe("abc.json");
    expect(s.accounts[0].status).toBe(1);
    expect(s.accounts[1].status).toBe(0);
    expect(s.error).toBe("");
  });

  it("fetchAccounts 官方 code!=200 -> 记录官方 msg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 500, msg: "读取账号失败", data: null }, false, 500),
      ),
    );

    await useCookiesStore.getState().fetchAccounts();

    expect(useCookiesStore.getState().accounts).toHaveLength(0);
    expect(useCookiesStore.getState().error).toContain("读取账号失败");
  });

  it("importCookie 构造 multipart 并调 POST /uploadCookie，成功后触发校验", async () => {
    useCookiesStore.setState({
      accounts: [rowToCookiedAccount(ROW_DOUYIN)],
    });
    // 第一次 /uploadCookie 成功，随后自动调 /getValidAccounts 刷新
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 200, msg: "Cookie文件上传成功", data: null }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 200, msg: null, data: [ROW_DOUYIN] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(['{"cookies":[]}'], "cookie.json", {
      type: "application/json",
    });
    await useCookiesStore.getState().importCookie(file, 3);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5409/uploadCookie");
    expect(init).toBeDefined();
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get("file")).toStrictEqual(file);
    expect(fd.get("id")).toBe("3");
    expect(fd.get("platform")).toBe("3");
    // 导入后自动触发一次 getValidAccounts
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:5409/getValidAccounts",
    );
    expect(useCookiesStore.getState().error).toBe("");
  });

  it("importCookie 官方失败 -> 抛出且记录错误", async () => {
    useCookiesStore.setState({
      accounts: [rowToCookiedAccount(ROW_DOUYIN)],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 500, msg: "上传Cookie文件失败", data: null }, false, 500),
      ),
    );

    const file = new File(['{"cookies":[]}'], "cookie.json", {
      type: "application/json",
    });
    await expect(
      useCookiesStore.getState().importCookie(file, 3),
    ).rejects.toThrow("上传Cookie文件失败");

    expect(useCookiesStore.getState().error).toContain("上传Cookie文件失败");
  });

  it("validateAll 调 GET /getValidAccounts 并更新 status", async () => {
    useCookiesStore.setState({
      accounts: [rowToCookiedAccount([3, 3, "abc.json", "抖音号", 1] as const)],
    });
    // 官方校验后抖音号仍有效，小红书号被置为失效
    const rows = [
      [3, 3, "abc.json", "抖音号", 1],
      [1, 1, "xhs.json", "小红书号", 0],
    ] as const;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, msg: null, data: rows }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useCookiesStore.getState().validateAll();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/getValidAccounts",
      undefined,
    );
    const s = useCookiesStore.getState();
    expect(s.accounts).toHaveLength(2);
    expect(s.accounts[0].status).toBe(1);
    expect(s.accounts[1].status).toBe(0);
    expect(s.validating).toBe(false);
  });

  it("exportCookie 打开下载并触发浏览器下载", async () => {
    const blob = new Blob(['{"cookies":[]}'], { type: "application/json" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => blob,
    });
    vi.stubGlobal("fetch", fetchMock);

    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    // jsdom 没有 createElement 的完整行为，用真实 DOM 但替换 click
    const appendChildSpy = vi.spyOn(document.body, "appendChild");
    const removeSpy = vi.spyOn(HTMLElement.prototype, "remove");

    await useCookiesStore.getState().exportCookie("abc.json", "抖音号-3.json");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/downloadCookie?filePath=abc.json",
    );
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    void click;
  });

  it("exportCookie 下载失败 -> 透传官方 msg 并抛出错误", async () => {
    // 官方 /downloadCookie 对缺失文件返回 {code:500, msg:"Cookie文件不存在"} + HTTP 404
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ code: 500, msg: "Cookie文件不存在", data: null }),
        text: async () => JSON.stringify({ code: 500, msg: "Cookie文件不存在", data: null }),
      }),
    );

    await expect(
      useCookiesStore.getState().exportCookie("missing.json", "x.json"),
    ).rejects.toThrow("Cookie文件不存在");
  });

  it("exportCookie 缺 filePath -> 参数缺失即服务端拒（覆盖 encodeURIComponent）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob() });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    vi.spyOn(document.body, "appendChild");
    vi.spyOn(HTMLElement.prototype, "remove");

    await useCookiesStore.getState().exportCookie("带空格 名.json", "n.json");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/downloadCookie?filePath=%E5%B8%A6%E7%A9%BA%E6%A0%BC%20%E5%90%8D.json",
    );
  });
});