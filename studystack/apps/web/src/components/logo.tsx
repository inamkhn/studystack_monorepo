import { cn } from "@/lib/utils";

/** Brand lockup: indigo node glyph + wordmark. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-component bg-primary/15 ring-1 ring-primary/40"
      >
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-primary" fill="none">
          <path
            d="M12 3 4 7.2l8 4.2 8-4.2L12 3Z"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinejoin="round"
          />
          <path
            d="m4 12.4 8 4.2 8-4.2M4 16.8l8 4.2 8-4.2"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinejoin="round"
            opacity={0.55}
          />
        </svg>
      </span>
      <span className="font-display text-lg font-bold tracking-tight text-ink">
        Study<span className="text-primary">Stack</span>
      </span>
    </span>
  );
}
