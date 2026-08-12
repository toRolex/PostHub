import { forwardRef } from "react";
import { cn } from "../../lib/utils";

const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-[84px] w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-body leading-6 text-fg transition-colors duration-150 ease-out",
      "placeholder:text-meta",
      "focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_var(--color-accent-tint)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
