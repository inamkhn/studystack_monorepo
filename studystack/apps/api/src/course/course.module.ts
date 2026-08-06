import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ConceptsModule } from "./concepts.module.js";
import { CourseController } from "./course.controller.js";
import { CourseService } from "./course.service.js";
import { StudentController } from "./student.controller.js";
import { TutorialController } from "./tutorial.controller.js";

@Module({
  imports: [AuthModule, JobsModule, AiModule, ConceptsModule],
  controllers: [
    CourseController,
    TutorialController,
    StudentController,
  ],
  providers: [CourseService],
  exports: [CourseService],
})
export class CourseModule {}
