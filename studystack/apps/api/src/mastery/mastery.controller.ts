import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Level } from "../generated/prisma/client.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ReviewContentService } from "./review-content.service.js";

/**
 * F8 — Adaptive Mastery Engine: read endpoints over spaced-repetition data.
 *
 * Mastery score writes have no client-facing endpoint — they're called
 * internally by Feature 7's `POST /modules/:id/quiz/submit` per concept_id.
 */
@ApiTags("mastery")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MasteryController {
  constructor(private readonly reviewContent: ReviewContentService) {}

  // ── F8: due-for-review concepts ──────────────────────────────────────

  /**
   * Returns concepts where `next_review_at <= now`, computed by the periodic
   * decay/scheduler job — surfaced when the student opens the app.
   */
  @Get("students/me/due-concepts")
  async getDueConcepts(@CurrentUser("id") userId: string) {
    return this.reviewContent.getDueConcepts(userId);
  }

  // ── F8: re-angled review content ─────────────────────────────────────

  /**
   * Returns a re-angled review explanation for this concept at the
   * authenticated student's level. Generates on cache miss via AiModule's
   * "different angle" path; `angleVariant` is server-selected (round-robin),
   * not client-specified.
   */
  @Get("concepts/:id/review-content")
  async getReviewContent(
    @Param("id") conceptId: string,
    @Query("level") level?: Level,
  ) {
    return this.reviewContent.getReviewContent(conceptId, level);
  }
}
