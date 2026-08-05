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
import { AuthService } from "./auth.service.js";
import { AgeBracketDto } from "./dto/age-bracket.dto.js";
import { LoginDto } from "./dto/login.dto.js";
import { RegisterDto } from "./dto/register.dto.js";
import { UpdateProfileDto } from "./dto/update-profile.dto.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { CurrentUser } from "./current-user.decorator.js";
import { UserWithoutPassword } from "./types.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  async register(@Body() dto: RegisterDto): Promise<UserWithoutPassword> {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.login(dto);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Body("refreshToken") refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.refresh(refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body("refreshToken") refreshToken: string): Promise<void> {
    await this.authService.logout(refreshToken ?? "");
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  async getProfile(@CurrentUser("id") userId: string): Promise<UserWithoutPassword> {
    return this.authService.getProfile(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("me")
  async updateProfile(
    @CurrentUser("id") userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserWithoutPassword> {
    return this.authService.updateProfile(userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch("me/age-bracket")
  async resolveAgeBracket(
    @CurrentUser("id") userId: string,
    @Body() dto: AgeBracketDto,
  ): Promise<Pick<UserWithoutPassword, "ageBracket">> {
    return this.authService.resolveAgeBracket(userId, dto);
  }
}
