import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { QuizSubmitDto } from "./dto/quiz-submit.dto.js";
import { QuizService } from "./quiz.service.js";

@ApiTags("assessment")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("modules")
export class QuizController {
  constructor(private readonly quizService: QuizService) {}

  // ── F7: module quiz (gated on module completion, per-student generation) ─

  @Get(":id/quiz")
  async getQuiz(@CurrentUser("id") userId: string, @Param("id") moduleId: string) {
    return this.quizService.getQuiz(userId, moduleId);
  }

  @Post(":id/quiz/submit")
  async submitQuiz(
    @CurrentUser("id") userId: string,
    @Param("id") moduleId: string,
    @Body() dto: QuizSubmitDto,
  ) {
    return this.quizService.submitQuiz(userId, moduleId, dto);
  }
}
