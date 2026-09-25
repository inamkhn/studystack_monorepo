import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { TutorialController } from "./tutorial.controller.js";
import { TutorialService } from "./tutorial.service.js";

@Module({
  imports: [AuthModule, CourseModule, AiModule],
  controllers: [TutorialController],
  providers: [TutorialService],
})
export class TutorialModule {}
