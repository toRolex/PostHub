import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface ChipProps {
  active?: boolean;
  count?: number;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}

/** 签名组件：筛选 pill（surface-warm 底，active = accent tint + 描边）。 */
function Chip({ active, count, children, onClick, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-label font-medium transition-colors duration-150 ease-out",
        active
          ? "border-accent bg-accent-tint text-accent-ink"
          : "border-border-soft bg-surface-warm text-fg-2 hover:border-border hover:text-fg",
        className,
      )}
    >
      {children}
      {count !== undefined && (
        <span className="text-caption tabular-nums text-meta">{count}</span>
      )}
    </button>
  );
}

export { Chip };
