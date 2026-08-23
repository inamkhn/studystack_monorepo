// ── Shared duration parser ──────────────────────────────────────────────
// Parses human-readable duration strings ("15m", "7d", etc.) into
// milliseconds and seconds. Used by both auth.module.ts (JWT config)
// and auth.service.ts (token signing / refresh token TTL).
//
// Supported units: s (seconds), m (minutes), h (hours), d (days)
//
// FAIL-CLOSED: an invalid value throws instead of falling back to a
// default. These strings configure token lifetimes — silently defaulting
// a typo'd JWT_EXPIRES_IN would mint tokens with the wrong TTL.
// ─────────────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

export function parseDurationToMs(duration: string): number {
  const match = duration.match(DURATION_RE);
  if (!match) {
    throw new Error(
      `Invalid duration "${duration}" — expected a positive integer with unit s|m|h|d (e.g. "15m", "7d")`,
    );
  }

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
      // Unreachable: DURATION_RE only matches the four units above.
      throw new Error(`Invalid duration unit in "${duration}"`);
  }
}

export function parseDurationToSeconds(duration: string): number {
  return Math.floor(parseDurationToMs(duration) / MS_PER_SECOND);
}
