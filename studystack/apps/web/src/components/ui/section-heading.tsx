import { cn } from "@/lib/utils";

/**
 * Section header pattern — uppercase mono eyebrow, display headline,
 * optional lede paragraph. Centered by default; pass `align="left"` for
 * asymmetrical editorial blocks.
 */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "center",
  className,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-2xl",
        align === "center" ? "mx-auto text-center" : "text-left",
        className,
      )}
    >
      <p className="text-label-md uppercase text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-headline-lg-mobile md:text-headline-xl-mobile lg:text-headline-xl">
        {title}
      </h2>
      {lede ? (
        <p className="mt-4 text-body-lg text-ink-subtle">{lede}</p>
      ) : null}
    </div>
  );
}
