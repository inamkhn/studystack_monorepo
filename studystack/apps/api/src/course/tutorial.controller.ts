import { Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { CourseService } from "./course.service.js";

@ApiTags("subtopics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("subtopics")
export class TutorialController {
  constructor(private readonly courseService: CourseService) {}

  // ── F6: tutorial fetch (cache-first) ───────────────────────────────────

  @Get(":id/tutorial")
  async getTutorial(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
  ) {
    return this.courseService.getTutorial(userId, subtopicId);
  }

  // ── F7: client-driven completion (feeds the quiz/final-project gates) ──

  @Patch(":id/complete")
  async markComplete(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
  ) {
    return this.courseService.markSubtopicComplete(userId, subtopicId);
  }
}
