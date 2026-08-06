import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { MasteryController } from "./mastery.controller.js";
import { MasteryMapController } from "./mastery-map.controller.js";
import { MasteryMapService } from "./mastery-map.service.js";
import { MasteryService } from "./mastery.service.js";
import { ReviewContentService } from "./review-content.service.js";

@Module({
  imports: [AuthModule, AiModule, CourseModule],
  controllers: [MasteryController, MasteryMapController],
  providers: [MasteryService, ReviewContentService, MasteryMapService],
  exports: [MasteryService, ReviewContentService],
})
export class MasteryModule {}
