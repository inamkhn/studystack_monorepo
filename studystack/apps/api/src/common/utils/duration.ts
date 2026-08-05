// ── Shared duration parser ──────────────────────────────────────────────
// Parses human-readable duration strings ("15m", "7d", etc.) into
// milliseconds and seconds. Used by both auth.module.ts (JWT config)
// and auth.service.ts (token signing / refresh token TTL).
//
// Supported units: s (seconds), m (minutes), h (hours), d (days)
// ─────────────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

/** Default fallback when the duration string is invalid (7 days in ms). */
const DEFAULT_MS = 7 * MS_PER_DAY;

export function parseDurationToMs(duration: string): number {
  const match = duration.match(DURATION_RE);
  if (!match) return DEFAULT_MS;

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * MS_PER_SECOND;
    case "m":
      return value * MS_PER_MINUTE;
    case "h":
      return value * MS_PER_HOUR;
    case "d":
      return value * MS_PER_DAY;
    default:
      return DEFAULT_MS;
  }
}

export function parseDurationToSeconds(duration: string): number {
  return Math.floor(parseDurationToMs(duration) / MS_PER_SECOND);
}
