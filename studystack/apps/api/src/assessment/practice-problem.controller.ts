import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { PracticeAttemptDto } from "./dto/practice-attempt.dto.js";
import { PracticeOverrideDto } from "./dto/practice-override.dto.js";
import { PracticeProblemService } from "./practice-problem.service.js";

@ApiTags("assessment")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("subtopics")
export class PracticeProblemController {
  constructor(private readonly practiceProblemService: PracticeProblemService) {}

  // ── F12: practice problems (calc-gated, cache-first) ────────────────

  @Get(":id/practice-problems")
  async getProblems(@Param("id") subtopicId: string) {
    return this.practiceProblemService.getProblems(subtopicId);
  }

  // ── F12: set/clear practice-problems override ───────────────────────

  @Patch(":id/practice-problems-override")
  async setOverride(
    @CurrentUser("id") _userId: string,
    @Param("id") subtopicId: string,
    @Body() dto: PracticeOverrideDto,
  ) {
    return this.practiceProblemService.setOverride(subtopicId, dto.override ?? null);
  }

  // ── F12: record a practice-problem attempt ──────────────────────────

  @Post(":id/practice-problems/:problemId/attempt")
  async recordAttempt(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
    @Param("problemId") problemId: string,
    @Body() dto: PracticeAttemptDto,
  ) {
    return this.practiceProblemService.recordAttempt(
      userId,
      subtopicId,
      problemId,
      dto.hintsUsed,
      dto.answer,
    );
  }
}
