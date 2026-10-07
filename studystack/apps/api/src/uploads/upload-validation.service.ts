// ── F1 §5/§6: upload validation service ─────────────────────────────────
// The single authority for the cheap pre-parse checks both upload paths
// (multipart POST and presign→confirm) and the ingestion worker share, so
// a limit is never enforced on one entry point and missed on another.
//
// It throws domain-level ExtractionError (from ai/pipeline) carrying a
// stable code + retryability. Callers translate: the HTTP layer maps to
// Nest exceptions, the worker lets the error flow into its classifier and
// fail the document. PDF has no archive layer here (its bounds — password
// detection, page cap, OCR limits — are enforced in extract-pdf.ts).

import { Injectable } from "@nestjs/common";
import type { UploadFileKind } from "../common/utils/file-validation.js";
import {
  ExtractionError,
  IngestionErrorCode,
} from "../ai/pipeline/types.js";
import { UPLOAD_MAX_BYTES } from "./upload-limits.js";
import { assertDocxArchiveSafe } from "./archive-safety.js";

@Injectable()
export class UploadValidationService {
  /**
   * Cheap declared-size gate for the presign step (bytes have not landed
   * yet). Enforced again against the *actual* stored size on confirm.
   */
  assertWithinSizeLimit(sizeBytes: number): void {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new ExtractionError(
        IngestionErrorCode.FileCorrupted,
        "Upload size is unknown or zero",
        false,
      );
    }
    if (sizeBytes > UPLOAD_MAX_BYTES) {
      throw new ExtractionError(
        IngestionErrorCode.FileTooLarge,
        `Upload is ${sizeBytes} bytes (limit ${UPLOAD_MAX_BYTES})`,
        false,
      );
    }
  }

  /**
   * Full pre-parse validation on the actual bytes: per-file size cap plus
   * the DOCX archive-bomb / dangerous-member guard. A real AV scanner
   * (e.g. ClamAV) would be injected here as an additional non-retryable
   * MALWARE_DETECTED gate once available — the call sites already branch
   * on the code, so wiring it in needs no upstream changes.
   */
  validateBytes(kind: UploadFileKind, buffer: Buffer): void {
    this.assertWithinSizeLimit(buffer.length);
    if (kind === "docx") {
      assertDocxArchiveSafe(buffer);
    }
  }
}
