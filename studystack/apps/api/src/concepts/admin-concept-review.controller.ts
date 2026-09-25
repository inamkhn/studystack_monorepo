import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { ConceptReviewService } from "./concept-review.service.js";

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
@Controller("admin/concept-review-candidates")
export class AdminConceptReviewController {
  constructor(private readonly conceptReviewService: ConceptReviewService) {}

  // ── F4 expanded: pending duplicate-review queue ────────────────────────

  @Get()
  async listCandidates() {
    return this.conceptReviewService.listReviewCandidates();
  }

  @Post(":id/merge")
  @HttpCode(HttpStatus.OK)
  async mergeCandidate(
    @CurrentUser("id") adminId: string,
    @Param("id") candidateId: string,
  ) {
    return this.conceptReviewService.mergeCandidate(candidateId, adminId);
  }

  @Post(":id/dismiss")
  @HttpCode(HttpStatus.OK)
  async dismissCandidate(
    @CurrentUser("id") adminId: string,
    @Param("id") candidateId: string,
  ) {
    return this.conceptReviewService.dismissCandidate(candidateId, adminId);
  }
}
