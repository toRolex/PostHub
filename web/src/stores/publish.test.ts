import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialPublishState, usePublishStore } from "./publish";
import { usePlatformStore } from "./platform";
import { useDaemonStore } from "./daemon";
import { formatDateTime } from "../lib/publishValidation";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const CONSTRAINTS = {
  douyin: {
    platform: "douyin",
    label: "抖音",
    min_lead_time_seconds: 7200,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 1209600,
    max_scheduled_per_day: null,
    cover_required: true,
    auto_cover_first_frame: false,
  },
  xiaohongshu: {
    platform: "xiaohongshu",
    label: "小红书",
    min_lead_time_seconds: 3600,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 604800,
    max_scheduled_per_day: null,
    cover_required: false,
    auto_cover_first_frame: true,
  },
  wechat: {
    platform: "wechat",
    label: "微信视频号",
    min_lead_time_seconds: 7200,
    schedule_min_seconds: 7200,
    schedule_max_seconds: 2592000,
    max_scheduled_per_day: 5,
    cover_required: false,
    auto_cover_first_frame: true,
  },
};

describe("publish store（发布表单 + 任务提交）", () => {
  beforeEach(() => {
    useDaemonStore.setState({ url: "http://127.0.0.1:9999" });
    usePlatformStore.setState({ constraints: { ...CONSTRAINTS } as never });
    usePublishStore.setState(initialPublishState);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createTask 成功 -> POST /tasks 并返回 task + jobs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          task: { id: 1, status: "pending", title: "春日踏青" },
          jobs: [{ id: 1, platform: "douyin", status: "pending" }],
        },
        true,
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    usePublishStore.setState({
      title: "春日踏青",
      videoPath: "/tmp/video.mp4",
      selectedPlatforms: ["douyin"],
      accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: null },
    });

    const result = await usePublishStore.getState().createTask();

    expect(result.task.id).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/tasks",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.title).toBe("春日踏青");
    expect(sent.jobs).toEqual([{ platform: "douyin", account_id: 1 }]);
    expect(sent.schedule_policy).toBe("immediate");
    expect(sent.silent).toBe(false);
  });

  it("createTask 校验失败 -> 抛错且不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    usePublishStore.setState({
      title: "",
      selectedPlatforms: ["douyin"],
      accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: null },
    });

    await expect(usePublishStore.getState().createTask()).rejects.toThrow(/标题/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createTask 定时载荷含 publish_at / publish_mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          task: { id: 2, status: "pending" },
          jobs: [{ id: 2, platform: "wechat", status: "pending" }],
        },
        true,
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const publishAt = formatDateTime(new Date(Date.now() + 3 * 24 * 3600 * 1000));
    usePublishStore.setState({
      title: "定时任务",
      videoPath: "/tmp/video.mp4",
      selectedPlatforms: ["wechat"],
      accountByPlatform: { douyin: null, xiaohongshu: null, wechat: 3 },
      schedulePolicy: "scheduled",
      publishMode: "platform_time",
      publishAt,
      silent: true,
    });

    await usePublishStore.getState().createTask();

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.schedule_policy).toBe("scheduled");
    expect(sent.publish_at).toBe(publishAt);
    expect(sent.publish_mode).toBe("platform_time");
    expect(sent.silent).toBe(true);
  });

  it("createTask 服务端 400 -> 抛出错误消息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "平台不匹配" }, false, 400)),
    );

    usePublishStore.setState({
      title: "x",
      videoPath: "/tmp/v.mp4",
      selectedPlatforms: ["douyin"],
      accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: null },
    });

    await expect(usePublishStore.getState().createTask()).rejects.toThrow("平台不匹配");
  });

  it("setPlatforms 自动为已选平台填充默认账号", () => {
    const accounts = [
      { id: 1, platform: "douyin", status: "active" },
      { id: 2, platform: "douyin", status: "active" },
      { id: 3, platform: "wechat", status: "active" },
    ];
    usePublishStore.getState().setPlatforms(["douyin", "wechat"], accounts as never);

    const s = usePublishStore.getState();
    expect(s.selectedPlatforms).toEqual(["douyin", "wechat"]);
    expect(s.accountByPlatform.douyin).toBe(1); // 默认取第一个
    expect(s.accountByPlatform.wechat).toBe(3);
  });
});
