import { cn } from "../../lib/utils";

export interface StatusMeta {
  /** 色点背景（浅档语义色） */
  dot: string;
  /** 标签文字（同色相加深档，保证对比） */
  text: string;
  label: string;
  pulse?: boolean;
}

interface StatusProps {
  meta: StatusMeta;
  className?: string;
}

/** 签名组件：语义色点 + 标签；可带脉冲动效。 */
function Status({ meta, className }: StatusProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-label font-medium",
        meta.text,
        className,
      )}
    >
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          meta.dot,
          meta.pulse && "animate-pulse-dot",
        )}
      />
      {meta.label}
    </span>
  );
}

export { Status };
