import type { Platform } from "./types";

export const PLATFORM_NAMES: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "视频号",
  kuaishou: "快手",
};

/**
 * 官方后端 platform type 释义（1 小红书 2 视频号 3 抖音 4 快手）。
 * 与 PLATFORM_NAMES 同源（中文名），但维度是官方 user_info.type，
 * 供 cookie 导入/导出等直连官方 seam 的场景使用。
 */
export const OFFICIAL_PLATFORM_NAMES: Record<number, string> = {
  1: "小红书",
  2: "视频号",
  3: "抖音",
  4: "快手",
};
