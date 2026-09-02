import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // `active:` states are the only press feedback that works on touch, where
  // there is no hover. The previous `hover-elevate`/`active-elevate-2` utilities
  // were Replit-preset classes that are not defined in this project's CSS, so
  // buttons had no feedback at all when tapped.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,opacity,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
           // @replit: no hover, and add primary border
           "bg-primary text-primary-foreground border border-primary-border active:brightness-95",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm border-destructive-border active:brightness-95",
        outline:
          // @replit Shows the background color of whatever card / sidebar / accent background it is inside of.
          // Inherits the current text color. Uses shadow-xs. no shadow on active
          // No hover state
          " border [border-color:var(--button-outline)] shadow-xs active:shadow-none active:bg-white/10 ",
        secondary:
          // @replit border, no hover, no shadow, secondary border.
          "border bg-secondary text-secondary-foreground border border-secondary-border active:brightness-110 ",
        // @replit no hover, transparent border
        ghost: "border border-transparent active:bg-white/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Touch targets: 44px is the platform minimum for a comfortable tap, so
        // controls are full size on mobile and condense from `sm` upward where a
        // pointer is likely.
        default: "min-h-11 px-4 py-2 sm:min-h-9",
        sm: "min-h-10 rounded-md px-3 text-xs sm:min-h-8",
        lg: "min-h-11 rounded-md px-8 sm:min-h-10",
        icon: "h-11 w-11 sm:h-9 sm:w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
