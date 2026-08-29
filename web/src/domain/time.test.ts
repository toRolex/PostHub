import { describe, expect, it } from "vitest";

import {
  carryStartDays,
  localTimeOf,
  nearestWholeHour,
  normalizeDailyTimes,
  resolveWechatTimer,
  parseHHMM,
  readTimeList,
  writeTimeList,
} from "./time";

describe("parseHHMM", () => {
  it("解析严格 HH:MM 并保留分钟", () => {
    expect(parseHHMM("09:05")).toBe(545);
  });

  it.each(["", "9", "09:5", "24:00", "12:60", "abc:00"]) (
    "非法输入 %j 显式拒绝",
    (value) => {
      expect(() => parseHHMM(value)).toThrow();
    },
  );
});

describe("定时时刻读写", () => {
  it("只接受 HH:MM 字符串，整数小时输入拒绝", () => {
    expect(() => readTimeList([0, 9, 23])).toThrow();
    expect(writeTimeList([0, 545, 1439])).toEqual(["00:00", "09:05", "23:59"]);
  });

  it("新 string[] 读取后规范化为去重排序的 HH:MM", () => {
    expect(normalizeDailyTimes(["14:30", "09:05", "14:30"])).toEqual([
      "09:05",
      "14:30",
    ]);
  });
});

describe("本地时间与最近整点", () => {
  it("只读取 Date 的本地时分，不把本地时间转换成 UTC", () => {
    const local = new Date(2026, 7, 27, 23, 45);
    expect(localTimeOf(local)).toEqual({ hour: 23, minute: 45 });
  });

  it.each([
    ["23:29", { hour: 23, dayCarry: 0 }],
    ["23:30", { hour: 0, dayCarry: 1 }],
    ["00:30", { hour: 1, dayCarry: 0 }],
  ] as const)("%s 按最近整点取整并处理午夜进位", (value, expected) => {
    expect(nearestWholeHour(value)).toEqual(expected);
  });

  it("午夜 carry 计入 startDays，不改变原有非负日数语义", () => {
    expect(carryStartDays(2, 1)).toBe(3);
    expect(carryStartDays(2, 0)).toBe(2);
  });

  it.each([
    ["14:29", { originalTime: "14:29", finalTime: "14:00", dayCarry: 0 }],
    ["14:30", { originalTime: "14:30", finalTime: "15:00", dayCarry: 0 }],
    ["23:30", { originalTime: "23:30", finalTime: "00:00", dayCarry: 1 }],
  ] as const)("视频号 %s 降级到最近整点并报告跨日", (value, expected) => {
    expect(resolveWechatTimer(value)).toMatchObject(expected);
  });
});
