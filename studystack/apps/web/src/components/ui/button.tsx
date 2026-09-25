import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Design-system button — apps/web/design.md §Components/Buttons
 *  - primary:  solid Electric Indigo, inset upper highlight, hover glow
 *  - secondary: frosted glass shell
 *  - subtle:   borderless ghost link
 * Labels are always JetBrains Mono `label-md`.
 */

const base =
  "inline-flex items-center justify-center gap-2 rounded-component text-label-md transition duration-200 active:translate-y-px";

const variants = {
  primary:
    "bg-primary text-on-primary shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)] hover:bg-primary-deep hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25),0_0_20px_rgb(99_102_241/0.45)]",
  secondary:
    "border border-white/15 bg-white/5 text-ink backdrop-blur-sm hover:bg-white/10",
  subtle: "text-ink-subtle hover:text-primary hover:underline",
} as const;

const sizes = {
  sm: "h-8 px-3",
  md: "h-10 px-5",
  lg: "h-12 px-7 text-label-lg",
} as const;

type ButtonProps = {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"a">, "className">;

/**
 * Renders an `<a>` — every landing CTA navigates, none submit. When the app
 * shell lands, form-submitting surfaces get a sibling `<ButtonAction>` rather
 * than a polymorphic `as` prop.
 */
export function Button({
  variant = "primary",
  size = "md",
  children,
  className,
  href,
  ...rest
}: ButtonProps) {
  return (
    <a
      href={href}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </a>
  );
}
