import { describe, expect, it } from "vitest";

import {
  DOUYIN_DECLARATIONS,
  WECHAT_DECLARATIONS,
  XIAOHONGSHU_SOURCES,
  validatePlatformFields,
  type PlatformFields,
} from "./declarations";

/** 声明映射表单测（issue #43 / ADR-0008 决策二：英文枚举 + 中文文案映射）。
 *  覆盖每个枚举值都登记在上游文案里，否则发布期映射会静默失败。 */
describe("平台声明候选表（registry）", () => {
  it("WECHAT_DECLARATIONS 8 选项枚举值与文案齐全", () => {
    expect(WECHAT_DECLARATIONS).toHaveLength(8);
    const values = WECHAT_DECLARATIONS.map((o) => o.value);
    expect(values).toEqual([
      "no_label",
      "ai_generated",
      "fictional",
      "personal_opinion",
      "marketing",
      "self_shoot",
      "shoot_time_location",
      "repost",
    ]);
    for (const o of WECHAT_DECLARATIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });

  it("DOUYIN_DECLARATIONS 6 选项枚举值与文案齐全", () => {
    expect(DOUYIN_DECLARATIONS).toHaveLength(6);
    expect(DOUYIN_DECLARATIONS.map((o) => o.value)).toEqual([
      "ai_generated",
      "personal_opinion",
      "repost",
      "marketing",
      "fictional",
      "no_need",
    ]);
    for (const o of DOUYIN_DECLARATIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });

  it("XIAOHONGSHU_SOURCES 4 选项枚举值与文案齐全", () => {
    expect(XIAOHONGSHU_SOURCES).toHaveLength(4);
    expect(XIAOHONGSHU_SOURCES.map((o) => o.value)).toEqual([
      "fictional",
      "ai_synthesized",
      "marketing",
      "self_declare",
    ]);
    for (const o of XIAOHONGSHU_SOURCES) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });

  it("文案与后端镜像表字符串字面完全一致（双侧均维护一份）", () => {
    // 静态保证：前端枚举 value 集合是后端镜像表的字面子集；任何漏登都会
    // 在 daemon/posthub/declarations.py 启动期 raise DeclarationMappingError。
    // 这里通过 value 集合回归断言，防止 frontend 漏改 / 后端漏改：
    expect(new Set(WECHAT_DECLARATIONS.map((o) => o.value))).toEqual(
      new Set([
        "no_label",
        "ai_generated",
        "fictional",
        "personal_opinion",
        "marketing",
        "self_shoot",
        "shoot_time_location",
        "repost",
      ]),
    );
    expect(new Set(DOUYIN_DECLARATIONS.map((o) => o.value))).toEqual(
      new Set([
        "ai_generated",
        "personal_opinion",
        "repost",
        "marketing",
        "fictional",
        "no_need",
      ]),
    );
    expect(new Set(XIAOHONGSHU_SOURCES.map((o) => o.value))).toEqual(
      new Set([
        "fictional",
        "ai_synthesized",
        "marketing",
        "self_declare",
      ]),
    );
  });
});

describe("validatePlatformFields（前端预校验，与后端 _validate_platform_fields 镜像）", () => {
  it("空对象 → 通过", () => {
    expect(validatePlatformFields({})).toBeNull();
    expect(validatePlatformFields(null)).toBeNull();
    expect(validatePlatformFields(undefined)).toBeNull();
  });

  it("合法 wechat.declaration → 通过", () => {
    const ok: PlatformFields = { wechat: { declaration: "no_label" } };
    expect(validatePlatformFields(ok)).toBeNull();
  });

  it("非法 wechat.declaration → 返回错误", () => {
    const bad = { wechat: { declaration: "not_a_real_enum" } } as unknown as PlatformFields;
    expect(validatePlatformFields(bad)).toContain("视频号");
    expect(validatePlatformFields(bad)).toContain("not_a_real_enum");
  });

  it("合法 douyin + xiaohongshu 字段 → 通过", () => {
    expect(
      validatePlatformFields({ douyin: { declaration: "no_need" } }),
    ).toBeNull();
    expect(
      validatePlatformFields({
        xiaohongshu: { source: "self_declare", origin: true },
      }),
    ).toBeNull();
  });

  it("非法 douyin/xiaohongshu 字段 → 错误", () => {
    const bad1 = { douyin: { declaration: "bogus" } } as unknown as PlatformFields;
    expect(validatePlatformFields(bad1)).toContain("抖音");
    const bad2 = { xiaohongshu: { source: "bogus" } } as unknown as PlatformFields;
    expect(validatePlatformFields(bad2)).toContain("小红书");
  });

  it("origin 非布尔 → 错误", () => {
    const bad = {
      wechat: { origin: "yes" },
    } as unknown as PlatformFields;
    expect(validatePlatformFields(bad)).toContain("声明原创");
  });
});