// ── PDF extraction (unpdf + Tesseract for scanned pages) ───────────────
// Digital pages: per-page text via unpdf's extractText. Scanned pages
// (thin text layer) are handled by extracting the embedded page image with
// unpdf's extractImages (canvas-free — works on any Node target), encoding
// it to PNG, and OCR'ing with Tesseract. OCR is capped at MAX_OCR_PAGES
// since WASM OCR is slow.

import {
  extractImages,
  extractText,
  extractTextItems,
  getDocumentProxy,
  type StructuredTextItem,
} from "unpdf";
import {
  MAX_IMAGES_PER_DOCUMENT,
  MAX_OCR_PAGES,
  MIN_IMAGE_DIMENSION,
  OCR_PAGE_CHAR_THRESHOLD,
  type ExtractedImage,
  type ExtractionResult,
} from "./types.js";
import { ocrImage } from "./ocr.js";
import { encodePng } from "./png.js";

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
 * OCRs a scanned page by pulling its embedded image out of the PDF.
 * Returns null when no usable image exists (multi-slice scans, odd
 * encodings) — the caller skips the page rather than failing the course.
 */
async function ocrScannedPage(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  pageNumber: number,
): Promise<string | null> {
  const images = await extractImages(proxy, pageNumber);
  if (images.length === 0) return null;

  // Use the largest image — a scanned page is typically one full-page scan
  // plus small artifacts (logos, stamps).
  const image = images.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  );

  const png = encodePng(image.data, image.width, image.height, image.channels);
  const text = (await ocrImage(png)).trim();
  return text || null;
}

/**
 * Collects embedded figures from a digital page (Phase C). Tiny images
 * (bullets, logos, stamps) are skipped; the per-document cap is enforced
 * by the caller. Scanned pages are NOT covered here — the full-page scan
 * is the page itself, not a figure.
 */
async function collectPageImages(
  proxy: Awaited<ReturnType<typeof getDocumentProxy>>,
  pageNumber: number,
): Promise<ExtractedImage[]> {
  let raw;
  try {
    raw = await extractImages(proxy, pageNumber);
  } catch {
    return [];
  }

  const figures: ExtractedImage[] = [];
  for (const image of raw) {
    if (
      image.width < MIN_IMAGE_DIMENSION ||
      image.height < MIN_IMAGE_DIMENSION
    ) {
      continue;
    }
    try {
      // Raster → PNG so storage is uniform regardless of the PDF's
      // internal encoding (DCT, JPX, indexed palettes…).
      const png = encodePng(image.data, image.width, image.height, image.channels);
      figures.push({
        data: png,
        format: "png",
        width: image.width,
        height: image.height,
        pageRef: pageNumber,
        sectionIndex: null, // resolved via pageRef during persistence
      });
    } catch {
      // Unencodable raster (odd color space) — drop it rather than
      // jeopardizing the page's text.
    }
  }
  return figures;
}

export async function extractPdfSections(
  buffer: Uint8Array,
): Promise<ExtractionResult> {
  // pdfjs rejects Buffer subclasses — hand it a plain Uint8Array view.
  const data = Buffer.isBuffer(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : buffer;
  const proxy = await getDocumentProxy(data);
  const numPages = proxy.numPages;
  const sections: ExtractionResult["sections"] = [];
  const images: ExtractedImage[] = [];
  let ocrPages = 0;

  const [{ text: pagesText }, { items: pagesItems }] = await Promise.all([
    extractText(proxy),
    extractTextItems(proxy),
  ]);

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
    const pageText = (pagesText[pageNumber - 1] ?? "").trim();

    if (pageText.length >= OCR_PAGE_CHAR_THRESHOLD) {
      // Digital page — one section per page. Items preserve line breaks
      // better than the flattened extractText string; heading detection on
      // raw PDF text is unreliable without font-size analysis, so headings
      // stay empty and F4 structuring derives structure from content.
      const body = itemsToText(pagesItems[pageNumber - 1] ?? []);
      sections.push({
        heading: "",
        body: body || pageText,
        pageRef: pageNumber,
      });

      // Figures on this page — attribution to a section happens during
      // persistence (image.pageRef → section.pageRef).
      if (images.length < MAX_IMAGES_PER_DOCUMENT) {
        const pageFigures = await collectPageImages(proxy, pageNumber);
        images.push(...pageFigures.slice(0, MAX_IMAGES_PER_DOCUMENT - images.length));
      }
      continue;
    }

    // Scanned / image-only page — OCR it (capped).
    if (ocrPages >= MAX_OCR_PAGES) continue;
    try {
      const ocrText = await ocrScannedPage(proxy, pageNumber);
      ocrPages++;
      if (ocrText) {
        sections.push({ heading: "", body: ocrText, pageRef: pageNumber, ocr: true });
      }
    } catch {
      // A single unreadable page must not fail the whole course — skip it
      // and keep the rest. Full-document failure is handled upstream
      // (zero sections → course marked failed).
    }
  }

  // unpdf hands cleanup to GC — PDFDocumentProxy exposes no destroy().
  return { sections, pages: numPages, ocrPages, images };
}
