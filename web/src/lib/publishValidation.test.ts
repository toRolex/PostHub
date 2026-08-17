import { describe, expect, it } from "vitest";

import {
  effectiveMinLeadSeconds,
  formatDateTime,
  parseDateTime,
  validatePublishForm,
  type PublishFormValues,
} from "./publishValidation";
import type { Platform, PlatformConstraint } from "../api/types";

const HOUR = 3600;
const DAY = 24 * HOUR;

const CONSTRAINTS: Record<Platform, PlatformConstraint> = {
  douyin: {
    platform: "douyin",
    label: "抖音",
    min_lead_time_seconds: 2 * HOUR,
    schedule_min_seconds: 2 * HOUR,
    schedule_max_seconds: 14 * DAY,
    max_scheduled_per_day: null,
    cover_required: true,
    auto_cover_first_frame: false,
  },
  xiaohongshu: {
    platform: "xiaohongshu",
    label: "小红书",
    min_lead_time_seconds: 1 * HOUR,
    schedule_min_seconds: 2 * HOUR,
    schedule_max_seconds: 7 * DAY,
    max_scheduled_per_day: null,
    cover_required: false,
    auto_cover_first_frame: true,
  },
  wechat: {
    platform: "wechat",
    label: "微信视频号",
    min_lead_time_seconds: 2 * HOUR,
    schedule_min_seconds: 2 * HOUR,
    schedule_max_seconds: 30 * DAY,
    max_scheduled_per_day: 5,
    cover_required: false,
    auto_cover_first_frame: true,
  },
  kuaishou: {
    platform: "kuaishou",
    label: "快手",
    min_lead_time_seconds: 1 * HOUR,
    schedule_min_seconds: 2 * HOUR,
    schedule_max_seconds: 7 * DAY,
    max_scheduled_per_day: null,
    cover_required: false,
    auto_cover_first_frame: true,
  },
};

const NOW = new Date(2099, 0, 1, 0, 0, 0); // 2099-01-01 00:00:00 本地

function baseForm(overrides: Partial<PublishFormValues> = {}): PublishFormValues {
  return {
    title: "春日踏青",
    videoPath: "/tmp/video.mp4",
    caption: "一起出发",
    coverMode: "auto",
    coverHorizontal: "",
    coverVertical: "",
    selectedPlatforms: ["douyin"],
    accountByPlatform: { douyin: 1, xiaohongshu: null, wechat: null },
    schedulePolicy: "immediate",
    publishAt: null,
    ...overrides,
  };
}

describe("publishValidation（发布表单校验，引用平台约束注册表）", () => {
  it("合法立即发布 -> 无错误", () => {
    expect(validatePublishForm(baseForm(), CONSTRAINTS, NOW)).toEqual([]);
  });

  it("标题为空 -> 报错", () => {
    const errors = validatePublishForm(baseForm({ title: "  " }), CONSTRAINTS, NOW);
    expect(errors.some((e) => e.includes("标题"))).toBe(true);
  });

  it("未选视频 -> 报错", () => {
    const errors = validatePublishForm(baseForm({ videoPath: "" }), CONSTRAINTS, NOW);
    expect(errors.some((e) => e.includes("视频"))).toBe(true);
  });

  it("未选平台 -> 报错", () => {
    const errors = validatePublishForm(baseForm({ selectedPlatforms: [] }), CONSTRAINTS, NOW);
    expect(errors.some((e) => e.includes("平台"))).toBe(true);
  });

  it("所选平台缺账号 -> 报错", () => {
    const errors = validatePublishForm(
      baseForm({ accountByPlatform: { douyin: null, xiaohongshu: null, wechat: null } }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors.some((e) => e.includes("账号"))).toBe(true);
  });

  it("定时未选时间 -> 报错", () => {
    const errors = validatePublishForm(
      baseForm({ schedulePolicy: "scheduled", publishAt: null }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors.some((e) => e.includes("发布时间"))).toBe(true);
  });

  it("小红书定时提前 1h -> 拦截（有效最小 2h）", () => {
    const errors = validatePublishForm(
      baseForm({
        selectedPlatforms: ["xiaohongshu"],
        accountByPlatform: { douyin: null, xiaohongshu: 2, wechat: null },
        schedulePolicy: "scheduled",
        publishAt: "2099-01-01 01:00:00",
      }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors.some((e) => e.includes("小红书") && e.includes("2 小时"))).toBe(true);
  });

  it("抖音定时提前 2h -> 通过（边界）", () => {
    const errors = validatePublishForm(
      baseForm({
        schedulePolicy: "scheduled",
        publishAt: "2099-01-01 02:00:00",
      }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors).toEqual([]);
  });

  it("小红书定时超 7 天 -> 拦截", () => {
    const errors = validatePublishForm(
      baseForm({
        selectedPlatforms: ["xiaohongshu"],
        accountByPlatform: { douyin: null, xiaohongshu: 2, wechat: null },
        schedulePolicy: "scheduled",
        publishAt: "2099-01-08 00:00:01",
      }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors.some((e) => e.includes("窗口"))).toBe(true);
  });

  it("抖音定时超 14 天 -> 拦截", () => {
    const errors = validatePublishForm(
      baseForm({
        schedulePolicy: "scheduled",
        publishAt: "2099-01-15 00:00:01",
      }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors.some((e) => e.includes("窗口"))).toBe(true);
  });

  it("视频号定时 3 天 -> 通过（min_lead 2h，窗口 30 天）", () => {
    const errors = validatePublishForm(
      baseForm({
        selectedPlatforms: ["wechat"],
        accountByPlatform: { douyin: null, xiaohongshu: null, wechat: 3 },
        schedulePolicy: "scheduled",
        publishAt: "2099-01-04 00:00:00",
      }),
      CONSTRAINTS,
      NOW,
    );
    expect(errors).toEqual([]);
  });
});

describe("publishValidation（时间工具）", () => {
  it("effectiveMinLead = max(min_lead, schedule_min)", () => {
    expect(effectiveMinLeadSeconds(CONSTRAINTS.xiaohongshu)).toBe(2 * HOUR);
    expect(effectiveMinLeadSeconds(CONSTRAINTS.douyin)).toBe(2 * HOUR);
  });

  it("formatDateTime / parseDateTime 往返", () => {
    const s = formatDateTime(new Date(2099, 0, 1, 2, 3, 4));
    expect(s).toBe("2099-01-01 02:03:04");
    const d = parseDateTime("2099-01-01 02:03:04");
    expect(d.getFullYear()).toBe(2099);
    expect(d.getMinutes()).toBe(3);
  });
});
