import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminConceptReviewController } from "./admin-concept-review.controller.js";
import { ConceptController } from "./concept.controller.js";
import { ConceptReviewService } from "./concept-review.service.js";
import { ConceptService } from "./concept.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ConceptController, AdminConceptReviewController],
  providers: [ConceptService, ConceptReviewService],
  exports: [ConceptService],
})
export class ConceptsModule {}
