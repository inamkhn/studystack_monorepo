import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { JwtStrategy } from "./jwt.strategy.js";
import { RolesGuard } from "./roles.guard.js";
import { parseDurationToSeconds } from "../common/utils/duration.js";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const expiresIn = parseDurationToSeconds(
          config.get<string>("JWT_EXPIRES_IN", "15m")!,
        );
        return {
          secret: config.getOrThrow<string>("JWT_SECRET"),
          signOptions: { expiresIn },
        };
      },
    }),
    // Brute-force protection on auth endpoints. Redis-backed so limits hold
    // across instances and restarts (REDIS_URL — same store BullMQ uses).
    // 60/min per IP is the module default; login/register/refresh/logout
    // tighten it via @Throttle on the controller routes.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 60 }],
        storage: new ThrottlerStorageRedisService(
          config.get<string>("REDIS_URL", "redis://localhost:6379")!,
        ),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, RolesGuard],
})

export class AuthModule {}