import { describe, expect, it, vi } from "vitest";

import {
  buildPostVideoRequest,
  officialApi,
  type PostVideoRequest,
} from "./official";

/**
 * 契约测试：前端发布表单 → 官方 /postVideo 请求体。
 * 契约来源 @see daemon/sau_backend.py:408 `postVideo` 与
 * `myUtils/postVideo.py`（postVideo.py 会拼接 BASE_DIR/videoFile 与 cookiesFile）。
 *
 * 断言重点：
 * - 字段名与官方一致（fileList/accountList/type/title/tags/...）。
 * - type 整型映射：1 小红书 2 视频号 3 抖音 4 快手。
 * - fileList 用素材 file_path（videoFile 磁盘名）、accountList 用账号 cookieFile。
 */
describe("buildPostVideoRequest（表单 → /postVideo 契约）", () => {
  const files = ["uuid_a_春天.mp4"];
  const accounts = ["douyin_a.json"];

  it("抖音发布：type=3，字段名与官方一致", () => {
    const body = buildPostVideoRequest({
      platform: "douyin",
      files,
      accounts,
      title: "春日踏青",
      tags: ["春天", "旅行"],
    });
    expect(body).toMatchObject<PostVideoRequest>({
      fileList: files,
      accountList: accounts,
      type: 3,
      title: "春日踏青",
      tags: ["春天", "旅行"],
      enableTimer: false,
    });
    // 契约要求立即发布：禁用官方定时字段
    expect(body.enableTimer).toBe(false);
  });

  it("平台整型映射：1 小红书 2 视频号 3 抖音 4 快手", () => {
    expect(buildPostVideoRequest({ platform: "xiaohongshu", files, accounts, title: "x", tags: [] }).type).toBe(1);
    expect(buildPostVideoRequest({ platform: "wechat", files, accounts, title: "x", tags: [] }).type).toBe(2);
    expect(buildPostVideoRequest({ platform: "douyin", files, accounts, title: "x", tags: [] }).type).toBe(3);
    expect(buildPostVideoRequest({ platform: "kuaishou", files, accounts, title: "x", tags: [] }).type).toBe(4);
  });

  it("tags 缺省为空数组；描述折叠进 title（官方无独立 desc 字段）", () => {
    const body = buildPostVideoRequest({
      platform: "douyin",
      files,
      accounts,
      title: "标题",
      tags: [],
    });
    expect(body.tags).toEqual([]);

    const withCaption = buildPostVideoRequest({
      platform: "douyin",
      files,
      accounts,
      title: "标题",
      caption: "正文内容",
      tags: [],
    });
    expect(withCaption.title).toBe("标题\n正文内容");
  });

  it("指定封面时写入 thumbnail", () => {
    const body = buildPostVideoRequest({
      platform: "douyin",
      files,
      accounts,
      title: "x",
      tags: [],
      thumbnail: "cover.jpg",
    });
    expect(body.thumbnail).toBe("cover.jpg");
  });
});

describe("officialApi.postVideo（mock fetch）", () => {
  it("POST /postVideo 并携带契约请求体", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 200, msg: "发布任务已提交", data: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = buildPostVideoRequest({
      platform: "douyin",
      files: ["a.mp4"],
      accounts: ["b.json"],
      title: "t",
      tags: ["tag"],
    });
    await officialApi.postVideo("http://127.0.0.1:5409", payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5409/postVideo",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.type).toBe(3);
    expect(sent.fileList).toEqual(["a.mp4"]);
    expect(sent.accountList).toEqual(["b.json"]);
    expect(sent.title).toBe("t");
  });

  it("官方校验错误（code 400/500）透传 msg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 400, msg: "账号列表不能为空", data: null }),
      }),
    );
    const payload = buildPostVideoRequest({
      platform: "douyin",
      files: ["a.mp4"],
      accounts: [],
      title: "t",
      tags: [],
    });
    await expect(
      officialApi.postVideo("http://127.0.0.1:5409", payload),
    ).rejects.toThrow("账号列表不能为空");
  });
});
