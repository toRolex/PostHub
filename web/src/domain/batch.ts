/**
 * 矩阵批量发布领域骨架：类型 + itemKey 约定 + 展开规则单点（issue #56）。
 *
 * - 批量相关类型唯一定义于此文件。
 * - itemKey 拼接/解析约定唯一定义于 keyOf / parseKey；不 escape
 *   （信任 filePath 与 cookie 文件名不含 "|"），parseKey 用 lastIndexOf 防御。
 * - 展开规则唯一定义于 buildBatchItemRefs；preview / result / submit 各自 map 加字段。
 */

import type { Platform } from "../api/types";
import type { PlatformFields } from "./declarations";
import { validatePlatformFields } from "./declarations";
import { normalizeDailyTimes, normalizeHHMM } from "./time";

/** 整批共用时刻池（HH:MM 字符串，提交时分钟保持不变）。 */
export type DailyTime = string;

/** 单视频条目定时模式：立即发布 / 定时发布。 */
export type BatchMode = "immediate" | "timer";

/**
 * 单视频条目：每个视频一条，记录该视频要发哪些平台账号、用什么模式。
 *
 * 对应 issue #37 prototype 内联片段。shape 与内联一致，仅做 TS 化：
 * - filePath 必填（videoFile/ 下的磁盘文件名，即 file_records.file_path）。
 * - mode='timer' 时 startDays + timeOfDay 必填；timeOfDay 必须来自 dailyTimes 池。
 * - accountCookiesByPlatform 承载 cookie 文件名字符串数组；store 层做 number id ↔
 *   string 映射。该选择让 buildBatchItemsFromMatrix 成为不依赖 accounts store 的纯函数。
 * - videosPerDay 不暴露（硬写 1），不在 type 上表达。
 */
export interface BatchItem {
  filePath: string;
  title: string;
  caption: string;
  /** 标签输入态字符串（提交时 parseTags 拆分成数组）。 */
  tags: string;
  /** 按平台选中的账号 cookie 文件名数组（cookiesFile/ 下的磁盘文件名）。 */
  accountCookiesByPlatform: Partial<Record<Platform, string[]>>;
  mode: BatchMode;
  /** mode='timer' 必填；mode='immediate' 忽略。 */
  startDays?: number;
  /** 'HH:MM'，mode='timer' 必填，从 dailyTimes 池里挑 1 个。 */
  timeOfDay?: string;
  /** 内容声明按平台分键透传（issue #43）；覆盖账号 defaultPlatformFields。 */
  platformFields?: PlatformFields;
}

/**
 * 单视频条目提交结果（按 item 维度反馈，不再按平台聚合）。
 *
 * 矩阵模式下同一平台可能有多个账号 → 展开为多个 PostVideoRequest 项，
 * 每项独立反馈；itemKey 由 keyOf 生成（filePath + cookie 组合），用于稳定去重。
 */
export interface BatchItemResult {
  /** keyOf(filePath, cookie) 生成的稳定 key。便于 UI 按 key 渲染行反馈。 */
  itemKey: string;
  fileName: string;
  platform: Platform;
  /** 展开项对应的账号 cookie 文件名（渲染时直接取，不再从 itemKey 反解）。 */
  accountCookie: string;
  mode: BatchMode;
  /** mode='timer' 时透传。 */
  timeOfDay?: string;
  startDays?: number;
  /** 该账号×视频展开项是否提交成功（官方返回 200）。 */
  ok: boolean;
  /** 失败原因（成功时为「批量发布任务已提交」之类的固定文案）。 */
  msg: string;
}

/** itemKey 唯一拼接点：filePath + "|" + cookie，不 escape。 */
export function keyOf(filePath: string, cookie: string): string {
  return `${filePath}|${cookie}`;
}

/** itemKey 唯一解析点：lastIndexOf 取最后一个分隔符，防御 filePath 含 "|"。 */
export function parseKey(itemKey: string): { filePath: string; cookie: string } {
  const idx = itemKey.lastIndexOf("|");
  return { filePath: itemKey.slice(0, idx), cookie: itemKey.slice(idx + 1) };
}

/** (item, platform, cookie) 三元组引用；展开规则的单一来源。 */
export interface BatchItemRef {
  item: BatchItem;
  platform: Platform;
  cookie: string;
}

/** 把 BatchItem[] × 平台 × 账号展开为三元组序列；跳过空账号数组。 */
export function buildBatchItemRefs(items: BatchItem[]): BatchItemRef[] {
  const refs: BatchItemRef[] = [];
  for (const item of items) {
    for (const [platform, accounts] of Object.entries(item.accountCookiesByPlatform) as [
      Platform,
      string[],
    ][]) {
      if (!accounts?.length) continue;
      for (const cookie of accounts) {
        refs.push({ item, platform, cookie });
      }
    }
  }
  return refs;
}

/**
 * 批量校验错误。row 从 1 起编号；整批级错误（空批次）row=0、filePath=""。
 */
export type ValidationError = { row: number; filePath: string; msg: string };

/**
 * 批量校验唯一实现：返回结构化 ValidationError[]。
 * store.validate() 在边界拼「第 N 行：」前缀；组件按 filePath 分组重排版。
 */
export function validateBatch(items: BatchItem[], dailyTimes: string[]): ValidationError[] {
  const errors: ValidationError[] = [];
  if (items.length === 0) {
    errors.push({ row: 0, filePath: "", msg: "请至少添加一条视频" });
  }
  let normalizedDailyTimes: string[] = [];
  try {
    normalizedDailyTimes = normalizeDailyTimes(dailyTimes);
  } catch {
    errors.push({ row: 0, filePath: "", msg: "每日时刻须为 HH:MM（小时 0-23，分钟 0-59）" });
  }
  const dailyTimesSet = new Set(normalizedDailyTimes);
  items.forEach((item, idx) => {
    const row = idx + 1;
    if (!item.title.trim()) {
      errors.push({ row, filePath: item.filePath, msg: "标题不能为空" });
    }
    const hasAccount = (Object.values(item.accountCookiesByPlatform) as string[][]).some(
      (a) => a && a.length > 0,
    );
    if (!hasAccount) {
      errors.push({ row, filePath: item.filePath, msg: "请至少选择一个平台的账号" });
    }
    if (item.mode === "timer") {
      let normalizedTime: string | undefined;
      if (item.timeOfDay) {
        try {
          normalizedTime = normalizeHHMM(item.timeOfDay);
        } catch {
          // 统一落入“未从时刻池选择”的领域错误，避免非法值绕过校验。
        }
      }
      if (!normalizedTime || !dailyTimesSet.has(normalizedTime)) {
        errors.push({
          row,
          filePath: item.filePath,
          msg: "定时模式必须从顶部时刻表挑 1 个时刻（timeOfDay）",
        });
      }
      if (
        item.startDays === undefined ||
        !Number.isInteger(item.startDays) ||
        item.startDays < 0
      ) {
        errors.push({
          row,
          filePath: item.filePath,
          msg: "定时模式必须设置起始日 startDays >= 0",
        });
      }
    }
    const fieldError = validatePlatformFields(item.platformFields);
    if (fieldError) errors.push({ row, filePath: item.filePath, msg: fieldError });
  });
  return errors;
}

/**
 * 视频号单账号累计定时任务计数（issue #40；计数规则唯一定义点，issue #58）。
 *
 * 统计 `mode='timer'` 且 `accountCookiesByPlatform.wechat` 命中的 item 数：每 item 对每个
 * 命中的 cookie 计一次。返回 cookie → 次数的 Map；未命中 cookie 不出现在 Map 中
 * （消费方用 `?? 0` 兜底）。本批次内累计；跨批次历史由官方兜底。
 */
export function wechatScheduledCountsByCookie(items: BatchItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    if (item.mode !== "timer") continue;
    for (const cookie of item.accountCookiesByPlatform.wechat ?? []) {
      map.set(cookie, (map.get(cookie) ?? 0) + 1);
    }
  }
  return map;
}
