import { beforeEach, describe, expect, it, vi } from "vitest";
import { officialApi } from "../api/official";
import { useCalendarStore } from "./calendar";

const record = {
  id: 1,
  accountId: 1,
  accountFile: "douyin.json",
  accountName: "账号",
  platform: "douyin" as const,
  videoId: "a.mp4",
  videoTitle: "视频",
  effectiveScheduledFor: "2026-08-31 10:00:00",
  scheduledFor: "2026-08-31 10:00:00",
  status: "scheduled" as const,
  publishedAt: null,
  runId: null,
  runItemId: null,
  recordedAt: "2026-08-29 10:00:00",
};

describe("账号日历 store", () => {
  beforeEach(() => {
    useCalendarStore.setState({
      records: [],
      from: null,
      to: null,
      loading: false,
      error: "",
    });
    vi.restoreAllMocks();
  });

  it("成功查询保存日期范围与记录", async () => {
    vi.spyOn(officialApi, "getPublishRecords").mockResolvedValue([record]);
    await useCalendarStore
      .getState()
      .fetchRecords("http://127.0.0.1:5409", "2026-08-31", "2026-09-06");
    expect(useCalendarStore.getState()).toMatchObject({
      records: [record],
      from: "2026-08-31",
      to: "2026-09-06",
      error: "",
      loading: false,
    });
  });

  it("查询失败保留已有记录，不误显示为空", async () => {
    useCalendarStore.setState({ records: [record] });
    vi.spyOn(officialApi, "getPublishRecords").mockRejectedValue(
      new Error("查询失败：daemon 不可用"),
    );
    await useCalendarStore
      .getState()
      .fetchRecords("http://127.0.0.1:5409", "2026-09-07", "2026-09-13");
    expect(useCalendarStore.getState()).toMatchObject({
      records: [record],
      error: "查询失败：daemon 不可用",
      loading: false,
    });
  });
});
