import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { QnaAskDto } from "./dto/qna-ask.dto.js";
import { QnaService } from "./qna.service.js";

@ApiTags("qna")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("subtopics")
export class QnaController {
  constructor(private readonly qnaService: QnaService) {}

  // ── F10: Q&A message history ────────────────────────────────────────

  @Get(":id/qna")
  async getHistory(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
  ) {
    return this.qnaService.getHistory(userId, subtopicId);
  }

  // ── F10: ask a question ─────────────────────────────────────────────

  @Post(":id/qna")
  async askQuestion(
    @CurrentUser("id") userId: string,
    @Param("id") subtopicId: string,
    @Body() dto: QnaAskDto,
  ) {
    return this.qnaService.askQuestion(userId, subtopicId, dto.question);
  }
}
