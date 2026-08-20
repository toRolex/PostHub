/**
 * 矩阵批量发布领域类型（issue #37 / #38）。
 *
 * 旧模型：「一组标题/标签 + 多账号」笛卡尔展开到所有选中视频。
 * 新模型：每视频一条 BatchItem，独立标题/描述/标签/账号/定时模式，
 *         整批共用顶部 dailyTimes chip 池（HH:MM）。
 *
 * 重写节奏：#38 落地这些类型 + buildBatchItemsFromMatrix + 重写后的 store；
 *          旧 store 接口以薄适配层保留（#02 切换时统一删除）。
 */

import type { Platform } from "../api/types";

/** 整批共用时刻池（HH:MM 字符串，提交时按整点取整映射回 0–23 整型）。 */
export type DailyTime = string;

/** 单视频条目定时模式：立即发布 / 定时发布。 */
export type BatchMode = "immediate" | "timer";

/**
 * 单视频条目：每个视频一条，记录该视频要发哪些平台账号、用什么模式。
 *
 * 对应 issue #37 prototype 内联片段。shape 与内联一致，仅做 TS 化：
 * - filePath 必填（videoFile/ 下的磁盘文件名，即 file_records.file_path）。
 * - mode='timer' 时 startDays + timeOfDay 必填；timeOfDay 必须来自 dailyTimes 池。
 * - accountIdsByPlatform 字段名为「ids」语义沿用 PRD，但实际承载 cookie 文件名
 *   字符串数组 —— 命名沿用以最小化 PRD 改动；store 层做 number id ↔ string 映射。
 *   该选择让 buildBatchItemsFromMatrix 成为不依赖 accounts store 的纯函数。
 * - videosPerDay 不暴露（硬写 1），不在 type 上表达。
 */
export interface BatchItem {
  filePath: string;
  title: string;
  caption: string;
  /** 标签输入态字符串（提交时 parseTags 拆分成数组）。 */
  tags: string;
  /**
   * 按平台选中的账号 cookie 文件名数组（cookiesFile/ 下的磁盘文件名）。
   * 命名沿用 PRD 内联片段的 accountIdsByPlatform，但语义是 cookie 文件名。
   */
  accountIdsByPlatform: Partial<Record<Platform, string[]>>;
  mode: BatchMode;
  /** mode='timer' 必填；mode='immediate' 忽略。 */
  startDays?: number;
  /** 'HH:MM'，mode='timer' 必填，从 dailyTimes 池里挑 1 个。 */
  timeOfDay?: string;
}

/**
 * 单视频条目提交结果（按 item 维度反馈，不再按平台聚合）。
 *
 * 矩阵模式下同一平台可能有多个账号 → 展开为多个 PostVideoRequest 项，
 * 每项独立反馈；itemKey 用来稳定去重（filePath + accountId 组合）。
 */
export interface BatchItemResult {
  /** 稳定 key：filePath + "|" + accountId。便于 UI 按 key 渲染行反馈。 */
  itemKey: string;
  fileName: string;
  platform: Platform;
  mode: BatchMode;
  /** mode='timer' 时透传。 */
  timeOfDay?: string;
  startDays?: number;
  /** 该账号×视频展开项是否提交成功（官方返回 200）。 */
  ok: boolean;
  /** 失败原因（成功时为「批量发布任务已提交」之类的固定文案）。 */
  msg: string;
}