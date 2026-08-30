import { describe, expect, it } from "vitest";
import {
  buildCalendarRows,
  formatCalendarDate,
  getWeekDates,
  mondayOfWeek,
  recordsByAccountDate,
  recordDate,
  type CalendarAccount,
} from "./calendar";
import type { PublishRecord } from "../api/official";

const accounts: CalendarAccount[] = [
  { id: 1, file: "douyin.json", name: "抖音号", platform: "douyin" },
];

const records: PublishRecord[] = [
  {
    id: 1,
    accountId: 1,
    accountFile: "douyin.json",
    accountName: "抖音号",
    platform: "douyin",
    videoId: "a.mp4",
    videoTitle: "视频 A",
    effectiveScheduledFor: "2026-08-31 14:37:00",
    scheduledFor: "2026-08-31 14:37:00",
    status: "scheduled",
    publishedAt: null,
    runId: null,
    runItemId: null,
    recordedAt: "2026-08-29 12:00:00",
  },
];

describe("账号周日历日期与分桶", () => {
  it("以周一为起点，跨月周保持七个本地日期", () => {
    const monday = mondayOfWeek(new Date(2026, 7, 31, 12));
    expect(formatCalendarDate(monday)).toBe("2026-08-31");
    expect(getWeekDates(monday).map(formatCalendarDate)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
  });

  it("按账号和本地日期分桶，并保留记录快照账号", () => {
    const rows = buildCalendarRows(accounts, records);
    expect(rows).toEqual([
      { id: 1, file: "douyin.json", name: "抖音号", platform: "douyin" },
    ]);
    const buckets = recordsByAccountDate(records);
    expect(buckets.get("1|2026-08-31")).toEqual(records);
  });

  it("账号改名或换平台后仍以历史记录快照作为日历行", () => {
    const currentAccount: CalendarAccount = {
      id: 1,
      file: "douyin.json",
      name: "新名称",
      platform: "wechat",
    };
    expect(buildCalendarRows([currentAccount], records)).toEqual([
      { id: 1, file: "douyin.json", name: "抖音号", platform: "douyin" },
    ]);
  });

  it("immediate published record 使用 publishedAt 作为日历日期和排序时间", () => {
    const immediate: PublishRecord = {
      ...records[0],
      id: 2,
      videoId: "b.mp4",
      videoTitle: "立即视频",
      effectiveScheduledFor: null,
      scheduledFor: null,
      status: "published",
      publishedAt: "2026-08-31 09:05:00",
    };
    expect(recordDate(immediate)).toBe("2026-08-31");
    const buckets = recordsByAccountDate([records[0], immediate]);
    expect(buckets.get("1|2026-08-31")?.map((record) => record.videoId)).toEqual([
      "b.mp4",
      "a.mp4",
    ]);
  });
});
