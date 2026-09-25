import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CourseModule } from "../course/course.module.js";
import { AdminConceptReviewController } from "./admin-concept-review.controller.js";
import { ConceptController } from "./concept.controller.js";
import { ConceptLinksController } from "./concept-links.controller.js";
import { ConceptReviewService } from "./concept-review.service.js";
import { ConceptService } from "./concept.service.js";
import { StudentController } from "./student.controller.js";

@Module({
  imports: [AuthModule, CourseModule],
  controllers: [
    ConceptController,
    ConceptLinksController,
    AdminConceptReviewController,
    StudentController,
  ],
  providers: [ConceptService, ConceptReviewService],
  exports: [ConceptService],
})
export class ConceptsModule {}
