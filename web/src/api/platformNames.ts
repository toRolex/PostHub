import type { Platform } from "./types";

export const PLATFORM_NAMES: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
  kuaishou: "快手",
};

/** 平台遍历顺序（单一来源）：视图需要迭代平台时统一 import。 */
export const PLATFORMS: Platform[] = ["xiaohongshu", "wechat", "douyin", "kuaishou"];
