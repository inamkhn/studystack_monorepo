import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Monospace status pill — design.md §Components/Chips & Badges
 * 1px bordered pill with an optional pulsing live dot, interior indigo wash.
 */
export function Badge({
  children,
  dotColor = "bg-primary",
  className,
}: {
  children: ReactNode;
  /** Tailwind bg-* class for the live dot; omit the dot by passing dot={false}. */
  dotColor?: string | false;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 py-1 pr-3 pl-2.5 text-label-sm uppercase tracking-[0.06em] text-ink-muted",
        className,
      )}
    >
      {dotColor ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden",
              dotColor,
            )}
          />
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", dotColor)} />
        </span>
      ) : null}
      {children}
    </span>
  );
}
