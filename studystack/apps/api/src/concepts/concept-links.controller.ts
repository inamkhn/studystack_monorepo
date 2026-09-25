import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ConceptService } from "./concept.service.js";

/**
 * F15 — per-subtopic concept links surface. Registered under the courses
 * path prefix so the public route (GET /courses/:id/subtopics/:subtopicId/
 * concept-links) stays stable after the module split.
 */
@ApiTags("courses")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses/:id/subtopics/:subtopicId")
export class ConceptLinksController {
  constructor(private readonly conceptService: ConceptService) {}

  @Get("concept-links")
  async getConceptLinks(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Param("subtopicId") subtopicId: string,
  ) {
    return this.conceptService.getConceptLinks(userId, courseId, subtopicId);
  }
}
