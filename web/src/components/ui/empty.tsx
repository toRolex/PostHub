import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "../../lib/utils";

interface EmptyProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  className?: string;
}

/** 签名组件：空状态（教学式文案，非「这里没东西」）。 */
function Empty({ title, description, icon, className }: EmptyProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-6 py-12 text-center text-muted",
        className,
      )}
    >
      {icon ?? <Inbox className="size-[34px] text-meta" strokeWidth={1.5} />}
      <p className="text-emph font-semibold text-fg">{title}</p>
      {description && (
        <p className="max-w-[34ch] text-label leading-6">{description}</p>
      )}
    </div>
  );
}

export { Empty };
