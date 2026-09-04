import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service.js";
import { ChangePasswordDto } from "./dto/change-password.dto.js";
import { ForgotPasswordDto } from "./dto/forgot-password.dto.js";
import { LoginDto } from "./dto/login.dto.js";
import { RefreshTokenDto } from "./dto/refresh-token.dto.js";
import { RegisterDto } from "./dto/register.dto.js";
import { ResetPasswordDto } from "./dto/reset-password.dto.js";
import { UpdateProfileDto } from "./dto/update-profile.dto.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { CurrentUser } from "./current-user.decorator.js";
import { UserWithoutPassword } from "./types.js";
import { Throttle, ThrottlerGuard, SkipThrottle } from "@nestjs/throttler";

// Per-IP rate limits (ms windows) harden the unauthenticated routes against
// brute force and credential/account abuse. The authenticated /me routes are
// skipped — throttling a signed-in user behind a shared IP (school networks)
// would punish legit traffic without adding security.
@ApiTags("auth")
@UseGuards(ThrottlerGuard)
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async register(@Body() dto: RegisterDto): Promise<UserWithoutPassword> {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.login(dto);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(@Body() dto: RefreshTokenDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.forgotPassword(dto);
    return { message: "If an account exists, a reset link was sent" };
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto);
    return { message: "Password reset successfully" };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch("change-password")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(
    @CurrentUser("id") userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.changePassword(userId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @SkipThrottle()
  @Get("me")
  async getProfile(@CurrentUser("id") userId: string): Promise<UserWithoutPassword> {
    return this.authService.getProfile(userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @SkipThrottle()
  @Patch("me")
  async updateProfile(
    @CurrentUser("id") userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserWithoutPassword> {
    return this.authService.updateProfile(userId, dto);
  }
}
