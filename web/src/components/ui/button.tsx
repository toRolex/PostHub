import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-label font-medium transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 active:translate-y-[0.5px] [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-white shadow-sm hover:bg-accent-hover active:bg-accent-active",
        secondary: "border-border bg-bg text-fg hover:bg-surface",
        ghost: "text-fg-2 hover:bg-surface hover:text-fg",
        danger: "text-danger hover:bg-danger-tint",
      },
      size: {
        sm: "h-7 rounded-sm px-2.5 text-caption",
        default: "h-[34px] px-3.5",
        lg: "h-10 px-5 text-body",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : "button"}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
