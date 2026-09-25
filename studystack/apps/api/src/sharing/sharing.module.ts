import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { CourseShareService } from "./course-share.service.js";
import { ProvenanceGateService } from "./provenance-gate.service.js";
import { PublicCourseController } from "./public-course.controller.js";
import { ShareController } from "./share.controller.js";

@Module({
  imports: [AuthModule, CourseModule],
  controllers: [ShareController, PublicCourseController],
  providers: [CourseShareService, ProvenanceGateService],
  // MarketplaceService (F17) reuses the same provenance gate — shared
  // internal logic, not an HTTP round-trip.
  exports: [ProvenanceGateService],
})
export class SharingModule {}
