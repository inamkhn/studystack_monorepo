import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { MasteryModule } from "../mastery/mastery.module.js";
import { FinalProjectController } from "./final-project.controller.js";
import { FinalProjectService } from "./final-project.service.js";
import { QuizController } from "./quiz.controller.js";
import { QuizService } from "./quiz.service.js";

@Module({
  imports: [AuthModule, AiModule, MasteryModule, CourseModule],
  controllers: [QuizController, FinalProjectController],
  providers: [QuizService, FinalProjectService],
})
export class AssessmentModule {}
