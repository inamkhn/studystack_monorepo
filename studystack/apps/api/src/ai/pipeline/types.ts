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
