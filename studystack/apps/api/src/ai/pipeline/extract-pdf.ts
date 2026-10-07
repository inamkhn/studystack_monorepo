// ── PDF extraction (unpdf + Tesseract for scanned pages) ───────────────
// Phase 2: bounded, resumable page windows. The ingestion processor walks
// a document PAGE_BATCH_SIZE pages per job, so this module exposes
// extractPdfPageWindow() instead of a whole-document pass — pdf.js pages
// are read lazily, a window only touches its own pages.
//
// Digital pages: per-page text via page.getTextContent(). Scanned pages
// (thin text layer) are handled by extracting the embedded page image with
// unpdf's extractImages (canvas-free — works on any Node target),
// downscaling it under the OCR pixel cap, encoding to PNG, and OCR'ing
// with Tesseract. OCR is capped per document since WASM OCR is slow.
//
// Document-level failures surface as ExtractionError with a stable code
// (design doc §5/§36): password-protected and over-limit PDFs need user
// action and must not be retried; odd parse errors stay retryable.

import {
  extractImages,
  getDocumentProxy,
  type StructuredTextItem,
} from "unpdf";
import {
  IngestionErrorCode,
  MAX_IMAGES_PER_DOCUMENT,
  MIN_IMAGE_DIMENSION,
  OCR_MAX_IMAGE_PIXELS,
  OCR_PAGE_CHAR_THRESHOLD,
  UPLOAD_MAX_PAGES,
  ExtractionError,
  type ExtractedImage,
} from "./types.js";
import { ocrImage } from "./ocr.js";
import { downscaleToMaxPixels, encodePng } from "./png.js";

/** getTextContent() shape we depend on (loose in unpdf's typings). */
interface PageTextContent {
  items: StructuredTextItem[];
}

export interface PdfPageWindowResult {
  sections: { heading: string; body: string; pageRef: number; ocr?: boolean }[];
  images: ExtractedImage[];
  /** Pages that went through OCR within this window. */
  ocrPages: number;
  /** Wall-clock spent OCR'ing this window (ms) — §41 ocr_duration_seconds. */
  ocrMs: number;
  pageCount: number;
  startPage: number;
  /** min(startPage + pageSize - 1, pageCount). */
  endPage: number;
  /** True when endPage < pageCount — the caller should request the next window. */
  hasMore: boolean;
}

/** Maps a pdf.js load failure onto our error taxonomy (doc §5/§36). */
function classifyPdfLoadError(error: unknown): ExtractionError {
  const err = error as { name?: string; message?: string; code?: number };
  const name = err?.name ?? "";
  const message = err?.message ?? "unknown PDF error";

  if (name.includes("Password") || err?.code === 1 || /password/i.test(message)) {
    return new ExtractionError(
      IngestionErrorCode.FilePasswordProtected,
      "The PDF is password-protected — remove protection and re-upload",
      false,
    );
  }
  if (name.includes("InvalidPDF") || err?.code === 2) {
    return new ExtractionError(
      IngestionErrorCode.FileCorrupted,
      `The PDF could not be parsed: ${message}`,
      false,
    );
  }
  return new ExtractionError(
    IngestionErrorCode.ParserFailed,
    `Could not open the PDF: ${message}`,
    true,
  );
}

/** Expands a page's text items into plain text, preserving line breaks. */
function itemsToText(items: StructuredTextItem[]): string {
  let text = "";
  for (const item of items) {
    text += item.str;
    if (item.hasEOL) text += "\n";
    else text += " ";
  }
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Largest embedded image on a page, or null. A scanned page is typically
 * one full-page scan plus small artifacts (logos, stamps). Rasters with an
 * channel count the PNG encoder can't handle are skipped.
 */
async function largestPageImage(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  pageNumber: number,
) {
  const images = await extractImages(proxy, pageNumber);
  if (images.length === 0) return null;
  const image = images.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  );
  if (image.channels !== 1 && image.channels !== 3 && image.channels !== 4) {
    return null;
  }
  return image;
}

/**
 * Extracts one window of pages [startPage, startPage + pageSize - 1].
 * `maxOcrPages` is the caller's remaining OCR budget for the document
 * (capped across resume boundaries via chunk metadata).
 */
export async function extractPdfPageWindow(
  buffer: Uint8Array,
  startPage: number,
  pageSize: number,
  maxOcrPages: number,
): Promise<PdfPageWindowResult> {
  // pdfjs rejects Buffer subclasses — hand it a plain Uint8Array view.
  const data = Buffer.isBuffer(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : buffer;

  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    proxy = await getDocumentProxy(data);
  } catch (error) {
    throw classifyPdfLoadError(error);
  }

  try {
    const pageCount = proxy.numPages;
    if (pageCount > UPLOAD_MAX_PAGES) {
      throw new ExtractionError(
        IngestionErrorCode.FileTooLarge,
        `PDF has ${pageCount} pages — the limit is ${UPLOAD_MAX_PAGES}; split the document and re-upload`,
        false,
      );
    }

    const from = Math.max(1, Math.min(startPage, pageCount));
    const to = Math.min(pageCount, from + pageSize - 1);

    const sections: PdfPageWindowResult["sections"] = [];
    const images: ExtractedImage[] = [];
    let ocrPages = 0;
    let ocrMs = 0;

    for (let pageNumber = from; pageNumber <= to; pageNumber++) {
      // Lazy per-page read — a window never parses the whole document.
      const page = await proxy.getPage(pageNumber);
      const { items } = (await page.getTextContent()) as unknown as PageTextContent;
      const pageText = itemsToText(items);

      if (pageText.length >= OCR_PAGE_CHAR_THRESHOLD) {
        // Digital page — one section per page. Heading detection on raw
        // PDF text is unreliable without font-size analysis, so headings
        // stay empty and F4 structuring derives structure from content.
        sections.push({ heading: "", body: pageText, pageRef: pageNumber });

        // Figures on this page — attribution to a section happens during
        // persistence (image.pageRef → section.pageRef).
        if (images.length < MAX_IMAGES_PER_DOCUMENT) {
          try {
            const raw = await extractImages(proxy, pageNumber);
            for (const image of raw) {
              if (images.length >= MAX_IMAGES_PER_DOCUMENT) break;
              if (
                image.width < MIN_IMAGE_DIMENSION ||
                image.height < MIN_IMAGE_DIMENSION ||
                (image.channels !== 1 &&
                  image.channels !== 3 &&
                  image.channels !== 4)
              ) {
                continue;
              }
              try {
                // Raster → PNG so storage is uniform regardless of the
                // PDF's internal encoding (DCT, JPX, indexed palettes…).
                const png = encodePng(
                  image.data,
                  image.width,
                  image.height,
                  image.channels as 1 | 3 | 4,
                );
                images.push({
                  data: png,
                  format: "png",
                  width: image.width,
                  height: image.height,
                  pageRef: pageNumber,
                  sectionIndex: null, // resolved via pageRef during persistence
                });
              } catch {
                // Unencodable raster (odd color space) — drop it rather
                // than jeopardizing the page's text.
              }
            }
          } catch {
            // Image layer unreadable on this page — the text stands.
          }
        }
        continue;
      }

      // Scanned / image-only page — OCR it (per-document budget).
      if (ocrPages >= maxOcrPages) continue;
      try {
        const image = await largestPageImage(proxy, pageNumber);
        if (image) {
          // OCR guardrail (doc §17): bound WASM memory per page.
          const scaled = downscaleToMaxPixels(
            image.data,
            image.width,
            image.height,
            image.channels as 1 | 3 | 4,
            OCR_MAX_IMAGE_PIXELS,
          );
          const png = encodePng(
            scaled.data,
            scaled.width,
            scaled.height,
            image.channels as 1 | 3 | 4,
          );
          const ocrStart = performance.now();
          const text = (await ocrImage(png)).trim();
          ocrMs += performance.now() - ocrStart;
          ocrPages++;
          if (text) {
            sections.push({
              heading: "",
              body: text,
              pageRef: pageNumber,
              ocr: true,
            });
          }
        }
      } catch (error) {
        if (error instanceof ExtractionError && !error.retryable) {
          throw error; // user-action-needed failures escalate
        }
        // A single unreadable page must not fail the whole course — skip
        // it and keep the rest. Document-level emptiness is handled by
        // the caller (zero chunks → document/run failed).
      }
    }

    return {
      sections,
      images,
      ocrPages,
      ocrMs,
      pageCount,
      startPage: from,
      endPage: to,
      hasMore: to < pageCount,
    };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(
      IngestionErrorCode.ParserFailed,
      `PDF extraction failed: ${error instanceof Error ? error.message : "unknown error"}`,
      true,
    );
  } finally {
    // Release the parsed document — the processor re-opens a fresh proxy
    // per page-window job.
    await proxy.cleanup().catch(() => undefined);
  }
}
