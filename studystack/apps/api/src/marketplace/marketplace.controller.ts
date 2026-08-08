import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { PublicQueryDto } from "../course/dto/public-query.dto.js";
import { MarketplaceService } from "./marketplace.service.js";

@ApiTags("marketplace")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // ── F17: submit course for review ────────────────────────────────────

  @Post("courses/:id/marketplace/submit")
  async submitForReview(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.marketplaceService.submitForReview(userId, courseId);
  }

  // ── F17: browse marketplace ──────────────────────────────────────────

  @Get("courses/marketplace")
  async browseMarketplace(@Query() query: PublicQueryDto) {
    return this.marketplaceService.browseMarketplace({
      subject: query.subject,
      level: query.level,
      goal: query.goal,
    });
  }

  // ── F17: purchase course ─────────────────────────────────────────────

  @Post("courses/:id/purchase")
  async purchaseCourse(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.marketplaceService.purchaseCourse(userId, courseId);
  }

  // ── F17: creator payout dashboard ────────────────────────────────────

  @Get("creators/me/payouts")
  async getPayouts(@CurrentUser("id") userId: string) {
    return this.marketplaceService.getPayouts(userId);
  }
}
