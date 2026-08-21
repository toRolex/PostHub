/**
 * PostHub 平台声明（issue #43 / ADR-0008）的内部枚举与单文件映射表。
 *
 * 持久化层存英文枚举（如 `no_label` / `ai_generated`）；上游 UI 真实中文
 * 文案（如 "无需标注" / "内容由AI生成"）集中维护在 `WECHAT_DECLARATION_TEXT` 等
 * 常量里，由 `daemon/posthub/declarations.py` 同名映射表镜像。
 *
 * 不 fork 上游：枚举值与文案变更只在本文件 + 后端镜像表同步更新。
 */

export type WechatDeclaration =
  | "no_label"
  | "ai_generated"
  | "fictional"
  | "personal_opinion"
  | "marketing"
  | "self_shoot"
  | "shoot_time_location"
  | "repost";

export type DouyinDeclaration =
  | "ai_generated"
  | "personal_opinion"
  | "repost"
  | "marketing"
  | "fictional"
  | "no_need";

export type XiaohongshuSource =
  | "fictional"
  | "ai_synthesized"
  | "marketing"
  | "self_declare";

/** UI 候选条目：枚举 + 上游真实文案。 */
export interface DeclarationOption<T extends string> {
  value: T;
  label: string;
}

export const WECHAT_DECLARATIONS: readonly DeclarationOption<WechatDeclaration>[] = [
  { value: "no_label", label: "无需标注" },
  { value: "ai_generated", label: "含AI生成内容" },
  { value: "fictional", label: "内容为虚构剧情，仅供娱乐" },
  { value: "personal_opinion", label: "个人观点，仅供参考" },
  { value: "marketing", label: "内容包含营销广告" },
  { value: "self_shoot", label: "内容为自行拍摄" },
  { value: "shoot_time_location", label: "添加拍摄时间和地点" },
  { value: "repost", label: "内容为转载" },
] as const;

export const DOUYIN_DECLARATIONS: readonly DeclarationOption<DouyinDeclaration>[] = [
  { value: "ai_generated", label: "内容由AI生成" },
  { value: "personal_opinion", label: "内容为个人观点或见解" },
  { value: "repost", label: "内容为转载信息" },
  { value: "marketing", label: "内容含营销推广信息" },
  { value: "fictional", label: "虚构演绎，仅供娱乐" },
  { value: "no_need", label: "无需添加自主声明" },
] as const;

export const XIAOHONGSHU_SOURCES: readonly DeclarationOption<XiaohongshuSource>[] = [
  { value: "fictional", label: "虚构演绎仅供娱乐" },
  { value: "ai_synthesized", label: "笔记含AI合成内容" },
  { value: "marketing", label: "已在正文中自主标注" },
  { value: "self_declare", label: "自主拍摄" },
] as const;

const WECHAT_SET = new Set<string>(WECHAT_DECLARATIONS.map((o) => o.value));
const DOUYIN_SET = new Set<string>(DOUYIN_DECLARATIONS.map((o) => o.value));
const XHS_SET = new Set<string>(XIAOHONGSHU_SOURCES.map((o) => o.value));

/** 槽位 → 候选 ui 列表（badge 文案展示复用 + registry 单一来源）。 */
const PLATFORM_OPTIONS: Record<string, readonly DeclarationOption<string>[]> = {
  wechat: WECHAT_DECLARATIONS,
  douyin: DOUYIN_DECLARATIONS,
  xiaohongshu: XIAOHONGSHU_SOURCES,
};

/**
 * 任务级 platform_fields 裁剪到单平台子键，剔除 null/undefined；
 * 空对象 → undefined 避免覆盖账号默认。
 * publish.ts / official.ts 共用（issue #43 review：消除双份 stripping 实现）。
 */
export function trimPlatformFields<T extends PlatformFields>(
  fields: T,
  platform: keyof T,
): T | undefined {
  const own = fields[platform] as Record<string, unknown> | undefined;
  if (!own) return undefined;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(own)) {
    if (v !== undefined && v !== null) stripped[k] = v;
  }
  if (Object.keys(stripped).length === 0) return undefined;
  return { [platform]: stripped } as unknown as T;
}

/**
 * 取单平台声明值的中文标签（用于徽标 / 提示）。
 * 数据驱动：`PLATFORM_OPTIONS` 给出 ui 列表；同 shape 用于 `validatePlatformFields`。
 */
export function renderDeclarationLabel(
  platform: keyof typeof PLATFORM_OPTIONS,
  value: PlatformFields[keyof PlatformFields] | undefined,
): string {
  if (!value) return "账号默认";
  const options = PLATFORM_OPTIONS[platform];
  const decl = (value as { declaration?: string; source?: string });
  const key = decl.declaration ?? decl.source;
  if (!key) return "账号默认";
  return options.find((o) => o.value === key)?.label ?? key;
}

/**
 * 校验任务级 platform_fields：值不在合法枚举内 → 返回错误信息。
 * 与 daemon `resolve_platform_fields` 的非法枚举检测对齐，
 * 让前端校验失败而不是后端 500（user story #35）。
 */
export function validatePlatformFields(fields: PlatformFields | null | undefined): string | null {
  if (!fields) return null;
  for (const [platform, section] of Object.entries(fields)) {
    if (!section) continue;
    if (platform === "wechat") {
      if (section.declaration && !WECHAT_SET.has(section.declaration)) {
        return `视频号「内容声明」取值非法：${section.declaration}`;
      }
      if (section.origin !== undefined && typeof section.origin !== "boolean") {
        return "视频号「声明原创」必须为布尔";
      }
    } else if (platform === "douyin") {
      if (section.declaration && !DOUYIN_SET.has(section.declaration)) {
        return `抖音「自主声明」取值非法：${section.declaration}`;
      }
    } else if (platform === "xiaohongshu") {
      if (section.source && !XHS_SET.has(section.source)) {
        return `小红书「添加内容类型声明」取值非法：${section.source}`;
      }
      if (section.origin !== undefined && typeof section.origin !== "boolean") {
        return "小红书「声明原创」必须为布尔";
      }
    }
  }
  return null;
}

/** platform_fields 子键形状（issue #43）。 */
export interface PlatformFields {
  wechat?: { declaration?: WechatDeclaration; origin?: boolean };
  douyin?: { declaration?: DouyinDeclaration };
  xiaohongshu?: { source?: XiaohongshuSource; origin?: boolean };
}