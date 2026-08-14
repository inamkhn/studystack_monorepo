// ── DOCX extraction (mammoth) ──────────────────────────────────────────
// mammoth converts DOCX to semantic HTML; headings (h1–h6) become section
// boundaries. The HTML is walked with a small regex state machine — a full
// DOM parser is overkill for this shape. Embedded images are captured via
// mammoth's convertImage hook and replaced with markers so each figure can
// be attributed to the section it sits in (Phase C).

import * as mammoth from "mammoth";
import {
  MAX_IMAGES_PER_DOCUMENT,
  type ExtractedImage,
  type ExtractedSection,
  type ExtractionResult,
} from "./types.js";

const MARKER_PREFIX = "__ss_asset_";
const MARKER_RE = /__ss_asset_(\d+)__/g;

function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Strips tags, keeps text. Blocks become newline-separated. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/(p|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

/** Sniffs PNG/JPEG magic bytes; anything else is not worth persisting. */
function sniffImageFormat(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

/** Parses width/height out of a PNG IHDR or JPEG SOF0/SOF2 header. */
function sniffImageDimensions(bytes: Uint8Array, format: "png" | "jpeg") {
  if (format === "png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (format === "jpeg") {
    for (let i = 2; i + 9 < bytes.length; i++) {
      if (bytes[i] !== 0xff) continue;
      const marker = bytes[i + 1];
      // SOF0–SOF3 except DHT(C4), JPGA(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
        };
      }
      // Skip segment
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 1 + segLen;
    }
  }
  return { width: null as number | null, height: null as number | null };
}

export async function extractDocxSections(
  buffer: Buffer,
): Promise<ExtractionResult> {
  // Capture every embedded image in document order; the <img> tag becomes
  // a marker so section splitting can attribute figures to sections.
  const images: ExtractedImage[] = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement((image) =>
        image.read().then((raw) => {
          if (images.length >= MAX_IMAGES_PER_DOCUMENT) return { src: "" };
          const bytes = new Uint8Array(raw);
          const format = sniffImageFormat(bytes);
          if (!format) return { src: "" };
          const { width, height } = sniffImageDimensions(bytes, format);
          const index = images.length;
          images.push({
            data: bytes,
            format,
            width,
            height,
            pageRef: 0,
            sectionIndex: null, // assigned during section splitting below
          });
          return { src: `${MARKER_PREFIX}${index}__` };
        }),
      ),
    },
  );

  // Split on heading tags, keeping the tag so we know it's a heading.
  const parts = html.split(/(?=<h[1-6][\s>])/i);
  const sections: ExtractedSection[] = [];

  let heading = "";
  let bodyParts: string[] = [];

  const flush = () => {
    const rawHtml = bodyParts.join("");
    // Attribute any markers inside this section's HTML to it before the
    // tags are stripped.
    for (const match of rawHtml.matchAll(MARKER_RE)) {
      const image = images[Number(match[1])];
      if (image && image.sectionIndex === null) {
        image.sectionIndex = sections.length;
      }
    }
    // Swap img tags for a token so image-only sections still push a
    // section (keeping attribution correct) and retrieval hits show where
    // a figure sits in the text.
    const body = htmlToText(
      rawHtml.replace(/<img[^>]*>/g, " [figure] "),
    );
    if (heading || body) {
      sections.push({ heading, body, pageRef: 0 });
    }
    bodyParts = [];
  };

  for (const part of parts) {
    if (!part.trim()) continue;
    const headingMatch = part.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    if (headingMatch) {
      flush();
      heading = htmlToText(headingMatch[1]);
      bodyParts.push(part.slice(headingMatch[0].length));
    } else {
      bodyParts.push(part);
    }
  }
  flush();

  return { sections, pages: 1, ocrPages: 0, images };
}
