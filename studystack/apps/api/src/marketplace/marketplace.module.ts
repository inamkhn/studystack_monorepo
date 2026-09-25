import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { SharingModule } from "../sharing/sharing.module.js";
import { AdminMarketplaceReviewController } from "./admin-marketplace.controller.js";
import { MarketplaceController } from "./marketplace.controller.js";
import { MarketplaceService } from "./marketplace.service.js";

@Module({
  imports: [AuthModule, CourseModule, SharingModule],
  controllers: [MarketplaceController, AdminMarketplaceReviewController],
  providers: [MarketplaceService],
})
export class MarketplaceModule {}
