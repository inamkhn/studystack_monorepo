import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { CourseShareService } from "./course-share.service.js";
import { ReportDto } from "./dto/report.dto.js";

/**
 * F14 — owner/student-facing share actions. Registered under the `courses`
 * prefix so routes (POST /courses/:id/publish|fork|report) are unchanged
 * from when they lived on CourseController.
 */
@ApiTags("courses")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses")
export class ShareController {
  constructor(private readonly courseShareService: CourseShareService) {}

  // ── F14: publish course (provenance gate) ────────────────────────────

  @Post(":id/publish")
  async publishCourse(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseShareService.publishCourse(userId, courseId);
  }

  // ── F14: fork a public course ────────────────────────────────────────

  @Post(":id/fork")
  @HttpCode(HttpStatus.CREATED)
  async forkCourse(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseShareService.forkCourse(userId, courseId);
  }

  // ── F14: report a course ─────────────────────────────────────────────

  @Post(":id/report")
  @HttpCode(HttpStatus.CREATED)
  async reportCourse(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: ReportDto,
  ) {
    return this.courseShareService.reportCourse(userId, courseId, dto.reason);
  }
}
