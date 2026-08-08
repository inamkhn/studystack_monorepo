import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { QnaController } from "./qna.controller.js";
import { QnaService } from "./qna.service.js";

@Module({
  imports: [AuthModule, AiModule],
  controllers: [QnaController],
  providers: [QnaService],
})
export class QnaModule {}
