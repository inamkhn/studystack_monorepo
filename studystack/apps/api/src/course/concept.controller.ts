import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ConceptService } from "./concept.service.js";

@ApiTags("concepts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("concepts")
export class ConceptController {
  constructor(private readonly conceptService: ConceptService) {}

  // ── F4 expanded: single concept ────────────────────────────────────────

  @Get(":id")
  async getConcept(@Param("id") id: string) {
    return this.conceptService.getConcept(id);
  }

  // ── F4 expanded: search by name/alias ──────────────────────────────────

  @Get()
  async searchConcepts(@Query("search") search?: string) {
    return this.conceptService.searchConcepts(search ?? "");
  }

  // ── F15: courses of the student containing this concept ────────────────

  @Get(":id/linked-courses")
  async getLinkedCourses(
    @CurrentUser("id") userId: string,
    @Param("id") conceptId: string,
  ) {
    return this.conceptService.getLinkedCourses(userId, conceptId);
  }
}
