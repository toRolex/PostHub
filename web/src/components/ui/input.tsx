import { forwardRef } from "react";
import { cn } from "../../lib/utils";

const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-bg px-3 text-body text-fg transition-colors duration-150 ease-out",
        "placeholder:text-meta",
        "focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_var(--color-accent-tint)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
