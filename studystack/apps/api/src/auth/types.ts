// ── Shared auth types ───────────────────────────────────────────────────
// Single source of truth for auth-related type aliases used across
// auth.controller.ts, auth.service.ts, jwt.strategy.ts, and
// current-user.decorator.ts.
// ─────────────────────────────────────────────────────────────────────────

import type { User } from "@prisma/client";

/** Public user profile — all fields except the password hash. */
export type UserWithoutPassword = Omit<User, "passwordHash">;

/** Shape of `request.user` attached by JwtStrategy.validate(). */
export interface JwtUser {
  id: string;
  email: string;
  name: string;
  role: string;
  ageBracket: string;
}

/** Shape of the JWT payload (matches signAccessToken). */
export interface JwtPayload {
  sub: string;
  role: string;
}
