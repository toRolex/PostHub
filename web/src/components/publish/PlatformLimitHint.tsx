/**
 * 视频号单日累计定时任务软提示徽标（issue #40）。
 *
 * 纯展示组件：
 * - `count <= limit`（默认 5）：黄色（warn tint）徽标「N/5」+ 文案「本批次累计 N 条定时任务」。
 * - `count > limit`：深黄（warn deep）徽标「N/5」+ 文案「超出仅提示，提交由官方兜底」。
 *
 * 不抛错、不阻止提交；超阈值只展示，不拦截。
 */

import { cn } from "../../lib/utils";

interface PlatformLimitHintProps {
  /** 本批次该视频号账号累计定时任务数（由 selectWechatScheduledCount 派生）。 */
  count: number;
  /** 视频号单日上限（默认 5，与官方工作值对齐；待实测）。 */
  limit?: number;
}

export function PlatformLimitHint({ count, limit = 5 }: PlatformLimitHintProps) {
  const exceeded = count > limit;
  return (
    <span
      data-slot="platform-limit-hint"
      data-exceeded={exceeded ? "true" : "false"}
      aria-label={
        exceeded
          ? `超出仅提示，提交由官方兜底：累计 ${count} 条定时任务，上限 ${limit}`
          : `本批次累计 ${count} 条定时任务，上限 ${limit}`
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption tabular-nums",
        exceeded ? "bg-warn-deep text-warn-tint" : "bg-warn-tint text-warn-deep",
      )}
    >
      <span className="font-semibold">
        {count}/{limit}
      </span>
      <span className="text-caption">
        {exceeded ? "超出仅提示，提交由官方兜底" : `本批次累计 ${count} 条定时任务`}
      </span>
    </span>
  );
}
