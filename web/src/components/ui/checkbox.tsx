import { forwardRef } from "react";
import { cn } from "../../lib/utils";

/** 原生 checkbox：accent 着色（DESIGN.md 16px accent-color）。 */
const Checkbox = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    type="checkbox"
    ref={ref}
    className={cn(
      "size-4 shrink-0 cursor-pointer rounded-[3px] accent-accent",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";

export { Checkbox };
