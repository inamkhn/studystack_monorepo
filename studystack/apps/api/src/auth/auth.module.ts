import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
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
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, RolesGuard],
})
export class AuthModule {}
