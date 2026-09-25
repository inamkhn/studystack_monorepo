import { Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { TutorialService } from "./tutorial.service.js";

@ApiTags("subtopics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("subtopics")
export class TutorialController {
  constructor(private readonly tutorialService: TutorialService) {}

  // ── F6: tutorial content (cached, or generated on first request) ───────

  @Get(":id/tutorial")
  async getTutorial(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
  ) {
    return this.tutorialService.getTutorial(userId, subtopicId);
  }

  // ── F7: completion tracking ────────────────────────────────────────────

  @Patch(":id/complete")
  async markComplete(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
  ) {
    return this.tutorialService.markSubtopicComplete(userId, subtopicId);
  }
}
