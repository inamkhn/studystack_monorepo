import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CourseShareService } from "./course-share.service.js";
import { PublicQueryDto } from "./dto/public-query.dto.js";

/**
 * Publicly-accessible course routes — no authentication required.
 * Separated from `ShareController` because that controller has a
 * class-level `@UseGuards(JwtAuthGuard)` that would gate public browsing.
 */
@ApiTags("courses")
@Controller("courses")
export class PublicCourseController {
  constructor(private readonly courseShareService: CourseShareService) {}

  // ── F14: public course browse ────────────────────────────────────────

  @Get("public")
  async browsePublicCourses(@Query() query: PublicQueryDto) {
    return this.courseShareService.browsePublicCourses({
      subject: query.subject,
      level: query.level,
      goal: query.goal,
    });
  }
}
