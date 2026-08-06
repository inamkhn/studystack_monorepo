import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { MasteryMapService } from "./mastery-map.service.js";

/**
 * F11 — Visual Mastery Map, course-scoped.
 *
 * Renders every module/subtopic node colored by the student's mastery
 * scores (red/amber/green thresholds) with per-node routing hints so the
 * client navigates without a second round-trip.
 *
 * Refresh behavior (per spec): the client re-fetches after every quiz
 * submission and on each scheduled decay recompute. This controller
 * doesn't implement push — it's a pull endpoint that the client can
 * re-query on those events.
 */
@ApiTags("mastery")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses")
export class MasteryMapController {
  constructor(private readonly masteryMap: MasteryMapService) {}

  @Get(":id/mastery-map")
  async getMasteryMap(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.masteryMap.buildMap(userId, courseId);
  }
}
