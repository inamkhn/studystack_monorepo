import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { FinalProjectSubmitDto } from "./dto/final-project-submit.dto.js";
import { FinalProjectService } from "./final-project.service.js";

@ApiTags("assessment")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses")
export class FinalProjectController {
  constructor(private readonly finalProjectService: FinalProjectService) {}

  // ── F9: final project (gated on full course completion, cached per course) ─

  @Get(":id/final-project")
  async getFinalProject(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.finalProjectService.getFinalProject(userId, courseId);
  }

  @Post(":id/final-project/submit")
  async submitFinalProject(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: FinalProjectSubmitDto,
  ) {
    return this.finalProjectService.submitFinalProject(userId, courseId, dto);
  }
}
