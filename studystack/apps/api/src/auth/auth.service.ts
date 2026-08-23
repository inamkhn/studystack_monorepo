import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AgeBracket, Prisma, User } from "../generated/prisma/client.js";
import * as bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { parseDurationToMs, parseDurationToSeconds } from "../common/utils/duration.js";
import { JwtPayload, UserWithoutPassword } from "./types.js";
import type { LoginDto } from "./dto/login.dto.js";
import type { RegisterDto } from "./dto/register.dto.js";
import type { UpdateProfileDto } from "./dto/update-profile.dto.js";

/**
 * Precomputed bcrypt cost-12 hash, used to burn the same hashing work on
 * the user-not-found login path so response timing doesn't reveal whether
 * an email exists.
 */
const DUMMY_PASSWORD_HASH =
  "$2a$12$MhKSxwDomtEUGdMJiJyuReF52EWGRpBaEuj6Ok4CCSHkVY.SG8QsO";

/**
 * Refresh tokens are stored as SHA-256 digests, not plaintext — a database
 * leak exposes hashes, not directly usable sessions.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ── Register ────────────────────────────────────────────────────────────

  async register(dto: RegisterDto): Promise<UserWithoutPassword> {
    // Normalize email so the unique constraint is case-insensitive in effect.
    const email = dto.email.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: dto.name,
          ageBracket: "unknown", // minor-safe default — never defaults to adult
        },
      });

      const { passwordHash: _, ...safeUser } = user;
      return safeUser;
    } catch (error) {
      // TOCTOU guard: a concurrent register with the same email loses the
      // unique-constraint race — surface it as the same 409, not a 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("Email already registered");
      }
      throw error;
    }
  }

  // ── Login ───────────────────────────────────────────────────────────────

  async login(dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      // Burn the same bcrypt work as the found-user path so the timing
      // difference doesn't leak whether the email is registered.
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException("Invalid email or password");
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.createRefreshToken(user.id);

    return { accessToken, refreshToken };
  }

  // ── Refresh ─────────────────────────────────────────────────────────────
  // Uses atomic updateMany to check-and-revoke, preventing concurrent
  // requests from reusing the same refresh token. Presenting an already
  // rotated token is treated as theft and revokes the whole token family.

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { token: hashToken(refreshToken) },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    if (stored.revokedAt) {
      // Replay of an already-rotated token — the theft signal. Revoke every
      // live token for this user. (Logout deletes rows instead of flagging,
      // so a post-logout stale request lands in the not-found branch above
      // and does NOT trigger this.)
      await this.revokeAllUserTokens(stored.userId);
      throw new UnauthorizedException("Refresh token already used");
    }

    // Atomic check-and-revoke: succeeds exactly once per token.
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) {
      // Lost a benign concurrent-rotation race (e.g. two tabs refreshing at
      // once) — the other request legitimately consumed this token.
      throw new UnauthorizedException("Refresh token already used");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: stored.userId },
    });

    if (!user) {
      throw new UnauthorizedException("User no longer exists");
    }

    const accessToken = this.signAccessToken(user);
    const newRefreshToken = await this.createRefreshToken(user.id);

    return { accessToken, refreshToken: newRefreshToken };
  }

  // ── Logout ──────────────────────────────────────────────────────────────

  async logout(refreshToken: string): Promise<void> {
    // Idempotent — deleteMany never throws when nothing matches. Deletion
    // (rather than a revokedAt flag) keeps post-logout replays out of the
    // theft branch in refresh(), which treats flagged tokens as replay.
    await this.prisma.refreshToken.deleteMany({
      where: { token: hashToken(refreshToken) },
    });
  }

  // ── Profile ─────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserWithoutPassword> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException("User no longer exists");
    }

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserWithoutPassword> {
    const data: {
      name?: string;
      ageBracket?: AgeBracket;
      explanationStyle?: typeof dto.explanationStyle;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.birthDate !== undefined) {
      // F6 gate: derive the bracket server-side from the birth date.
      const age = this.calculateAge(new Date(dto.birthDate));
      data.ageBracket = age >= 18 ? "adult" : "unknown";
    }
    if (dto.explanationStyle !== undefined)
      data.explanationStyle = dto.explanationStyle;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private signAccessToken(user: Pick<User, "id" | "role">): string {
    const expiresIn = parseDurationToSeconds(
      this.config.get<string>("JWT_EXPIRES_IN", "15m")!,
    );
    return this.jwt.sign(
      { sub: user.id, role: user.role } satisfies JwtPayload,
      { expiresIn },
    );
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(64).toString("hex");
    const ttlMs = parseDurationToMs(
      this.config.get<string>("JWT_REFRESH_EXPIRES_IN", "7d")!,
    );

    await this.prisma.refreshToken.create({
      data: {
        token: hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });

    return token;
  }

  private async revokeAllUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private calculateAge(birthDate: Date): number {
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDelta = today.getMonth() - birthDate.getMonth();
    if (
      monthDelta < 0 ||
      (monthDelta === 0 && today.getDate() < birthDate.getDate())
    ) {
      age--;
    }
    return age;
  }
}
