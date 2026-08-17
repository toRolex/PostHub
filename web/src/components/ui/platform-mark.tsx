import { cn } from "../../lib/utils";
import type { Platform } from "../../api/types";

export const PLATFORM_META: Record<Platform, { dot: string; name: string }> = {
  douyin: { dot: "bg-p-douyin", name: "抖音" },
  xiaohongshu: { dot: "bg-p-xhs", name: "小红书" },
  wechat: { dot: "bg-p-wechat", name: "视频号" },
  kuaishou: { dot: "bg-p-kuaishou", name: "快手" },
};

interface PlatformMarkProps {
  platform: Platform;
  className?: string;
}

/** 签名组件：平台品牌色 8px 色点 + 文字（文字不落品牌色，对比 ≥4.5:1）。 */
function PlatformMark({ platform, className }: PlatformMarkProps) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-caption font-medium text-fg-2",
        className,
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", meta.dot)} />
      {meta.name}
    </span>
  );
}

export { PlatformMark };
