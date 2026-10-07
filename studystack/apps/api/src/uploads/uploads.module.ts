// ── F1 upload-path validation module (§44) ──────────────────────────────
// Owns pre-parse safety (size caps, archive-bomb + dangerous-member
// heuristics) as a single-responsibility unit. Kept OUT of CourseService
// so course lifecycle and document-internals concerns stay separate; both
// the HTTP entrypoints and the ingestion worker import and call it.
import { Module } from "@nestjs/common";
import { UploadValidationService } from "./upload-validation.service.js";

@Module({
  providers: [UploadValidationService],
  exports: [UploadValidationService],
})
export class UploadsModule {}
