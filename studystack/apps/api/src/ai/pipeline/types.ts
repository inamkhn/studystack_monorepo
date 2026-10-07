// ── Extraction pipeline types (F1 Phase A) ─────────────────────────────
// Unified shape every extractor produces, regardless of source format.
// Sections feed chunking, needs_research_fill analysis, and later F4
// structuring — headings are first-class because module generation
// depends on them.

export interface ExtractedSection {
  /** Heading text; empty string when the content has no heading. */
  heading: string;
  /** Body text under the heading. */
  body: string;
  /** 1-based page number when known (PDF); 0 otherwise. */
  pageRef: number;
  /**
   * OCR-produced text. Kept separate so provenance/quality of scanned
   * content stays visible downstream (never silently mixed with digital
   * text).
   */
  ocr?: boolean;
}

/**
 * An image/diagram pulled out of an upload (F1 spec: keep them linked to
 * their source section, not floating loose). `data` is already in an
 * encodable form: PNG bytes for PDF rasters, original bytes for DOCX
 * embedded images. Attribution is by section index when the extractor
 * knows it (DOCX) or by page (PDF — resolved to sections downstream).
 */
export interface ExtractedImage {
  data: Uint8Array;
  /** "png" after encodePng; "jpeg" when the original stays as-is. */
  format: "png" | "jpeg";
  width: number | null;
  height: number | null;
  /** 1-based page (PDF); 0 when the format has no pages. */
  pageRef: number;
  /** Section the extractor could attribute the image to; null otherwise. */
  sectionIndex: number | null;
}

export interface ExtractionResult {
  sections: ExtractedSection[];
  /** Total pages seen (PDF); 1 for single-document formats. */
  pages: number;
  /** Pages that went through Tesseract OCR. */
  ocrPages: number;
  /** Embedded figures/diagrams found alongside the text. */
  images: ExtractedImage[];
}

/**
 * A page whose text layer is too thin to be usable — candidate for OCR.
 * Rendering + Tesseract is slow, so the pipeline caps how many it does.
 */
export const OCR_PAGE_CHAR_THRESHOLD = 30;
export const MAX_OCR_PAGES = 25;

/**
 * Figure extraction bounds (Phase C). Tiny images are bullets/logos, not
 * diagrams; the per-document cap keeps a figure-heavy deck from flooding
 * disk during ingestion.
 */
export const MIN_IMAGE_DIMENSION = 64;
export const MAX_IMAGES_PER_DOCUMENT = 20;

/** Body word count under which a headed section is flagged needs_research_fill. */
export const MIN_SECTION_BODY_WORDS = 20;

/** Chunking targets (tokens ≈ words × 1.3; we approximate with words). */
export const CHUNK_TARGET_WORDS = 600;
export const CHUNK_OVERLAP_WORDS = 60;
export const CHUNK_HARD_MAX_WORDS = 900;

// ── Phase 2: bounded, resumable extraction (design doc §5/§17/§22/§26) ──

/**
 * Version tag written to every chunk and ingestion run (doc §22). Bumping
 * it marks a pipeline change whose outputs differ enough to warrant a full
 * re-extract; a run also records the version that produced it.
 */
export const INGESTION_PIPELINE_VERSION = "f1-v2";

/** Safe positive-integer env read with a hard fallback (never NaN). */
function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Pages extracted+persisted per job (doc §26). Large documents are chopped
 * into page batches so one document never monopolizes a worker, and each
 * batch is a durable checkpoint a resumed run picks up after.
 */
export const PAGE_BATCH_SIZE = num(process.env.INGEST_PAGE_BATCH, 25);

/**
 * Pages one job extracts before checkpointing and re-enqueuing a
 * continuation (doc §26). Bounding job duration keeps a huge textbook
 * from occupying the worker (and its OCR lock) indefinitely, while still
 * letting small documents finish inside a single job.
 */
export const MAX_PAGES_PER_JOB = num(process.env.INGEST_JOB_PAGE_BUDGET, 100);

/**
 * Reject documents over this page count (doc §5). Default keeps the
 * documented 400+ page textbook use case working while bounding runaway
 * extractions; configurable so prod can tune to real capacity.
 */
export const UPLOAD_MAX_PAGES = num(process.env.UPLOAD_MAX_PAGES, 600);

// OCR guardrails (doc §17) — Tesseract.js is CPU-heavy WASM, so bound it.
/** Max wall-clock for one page's OCR before the worker is recycled. */
export const OCR_PAGE_TIMEOUT_MS = num(process.env.OCR_PAGE_TIMEOUT_MS, 60_000);
/** Above this pixel count an image is downscaled before OCR (memory cap). */
export const OCR_MAX_IMAGE_PIXELS = num(process.env.OCR_MAX_IMAGE_PIXELS, 4_000_000);
/** Recycle (terminate + recreate) the OCR worker every N pages to reclaim WASM heap. */
export const OCR_RECYCLE_AFTER_PAGES = num(process.env.OCR_RECYCLE_AFTER_PAGES, 50);

/**
 * Stable error codes for the ingestion pipeline (doc §36). Persisted on the
 * run + surfaced in the failure contract so the client can branch on cause
 * instead of parsing prose. Retryability drives whether the worker rethrows
 * to BullMQ (retryable) or fails the course directly (user-action-needed).
 */
export const IngestionErrorCode = {
  UnsupportedFileType: "UNSUPPORTED_FILE_TYPE",
  FileTooLarge: "FILE_TOO_LARGE",
  FileCorrupted: "FILE_CORRUPTED",
  FilePasswordProtected: "FILE_PASSWORD_PROTECTED",
  MalwareDetected: "MALWARE_DETECTED",
  ArchiveBomb: "ARCHIVE_BOMB",
  ParserFailed: "PARSER_FAILED",
  OcrFailed: "OCR_FAILED",
  OcrTimeout: "OCR_TIMEOUT",
  NoExtractableContent: "NO_EXTRACTABLE_CONTENT",
  EmbeddingFailed: "EMBEDDING_FAILED",
} as const;
export type IngestionErrorCodeValue =
  (typeof IngestionErrorCode)[keyof typeof IngestionErrorCode];

/** Extraction failures that carry an error code + retryable classification. */
export class ExtractionError extends Error {
  constructor(
    readonly code: IngestionErrorCodeValue,
    message: string,
    /** true → transient, let BullMQ retry; false → needs user action. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
