import { cn } from "../../lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  rows?: number;
}

/** 加载骨架：真实数据渲染前的占位（shimmer 动效，reduced-motion 自动降级）。 */
function Skeleton({ className, rows = 4, style, ...props }: SkeletonProps) {
  return (
    <div className="flex flex-col gap-3 py-3" {...props}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={cn("h-11 animate-shimmer rounded-md", className)}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--color-surface) 25%, var(--color-surface-warm) 50%, var(--color-surface) 75%)",
            backgroundSize: "200% 100%",
            ...style,
          }}
        />
      ))}
    </div>
  );
}

export { Skeleton };
