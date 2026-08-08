import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { MarketplaceService } from "./marketplace.service.js";

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
@Controller("admin/marketplace-review-queue")
export class AdminMarketplaceReviewController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // ── F17: list pending marketplace reviews ──────────────────────────────

  @Get()
  async listReviewQueue() {
    return this.marketplaceService.listReviewQueue();
  }

  // ── F17: approve a marketplace submission ──────────────────────────────

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  async approveSubmission(@Param("id") reviewId: string) {
    return this.marketplaceService.approveSubmission(reviewId);
  }

  // ── F17: reject a marketplace submission ───────────────────────────────

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  async rejectSubmission(@Param("id") reviewId: string) {
    return this.marketplaceService.rejectSubmission(reviewId);
  }
}
