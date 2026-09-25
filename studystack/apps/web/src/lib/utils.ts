/** Minimal className joiner — drops falsy values, single space between parts. */
export function cn(
  ...parts: Array<string | number | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
