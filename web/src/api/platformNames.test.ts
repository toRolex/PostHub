import { describe, expect, it } from "vitest";
import { PLATFORM_NAMES, PLATFORMS } from "./platformNames";
import {
  OFFICIAL_PLATFORM_TYPE,
  OFFICIAL_TYPE_PLATFORM,
  type OfficialPlatformType,
  type Platform,
} from "./types";

describe("PLATFORM_NAMES", () => {
  it("覆盖全部 Platform", () => {
    const platforms: Platform[] = ["douyin", "xiaohongshu", "wechat", "kuaishou"];
    for (const p of platforms) {
      expect(PLATFORM_NAMES[p]).toBeTruthy();
    }
  });

  it("手持官方 type 派生：每个 OfficialPlatformType 经 OFFICIAL_TYPE_PLATFORM 能取到中文名", () => {
    const types: OfficialPlatformType[] = [1, 2, 3, 4];
    for (const t of types) {
      expect(PLATFORM_NAMES[OFFICIAL_TYPE_PLATFORM[t]]).toBeTruthy();
    }
  });

  it("双向映射自洽：Platform -> type -> Platform 恒等，直查 = 双跳", () => {
    for (const p of PLATFORMS) {
      expect(OFFICIAL_TYPE_PLATFORM[OFFICIAL_PLATFORM_TYPE[p]]).toBe(p);
      expect(PLATFORM_NAMES[p]).toBe(
        PLATFORM_NAMES[OFFICIAL_TYPE_PLATFORM[OFFICIAL_PLATFORM_TYPE[p]]],
      );
    }
  });
});

describe("PLATFORMS", () => {
  it("顺序统一为 xiaohongshu / wechat / douyin / kuaishou", () => {
    expect(PLATFORMS).toEqual(["xiaohongshu", "wechat", "douyin", "kuaishou"]);
  });

  it("与 PLATFORM_NAMES 键集一致", () => {
    expect([...PLATFORMS].sort()).toEqual(Object.keys(PLATFORM_NAMES).sort());
  });
});
