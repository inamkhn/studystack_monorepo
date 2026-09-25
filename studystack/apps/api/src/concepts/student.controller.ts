import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ConceptService } from "./concept.service.js";

@ApiTags("students")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("students")
export class StudentController {
  constructor(private readonly conceptService: ConceptService) {}

  // ── F15: full concept-mastery graph across all enrolled courses ────────

  @Get("me/concept-graph")
  async getConceptGraph(@CurrentUser("id") userId: string) {
    return this.conceptService.getConceptGraph(userId);
  }
}
