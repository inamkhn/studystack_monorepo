// ── Plain-text / Markdown extraction ───────────────────────────────────
// Headings come from Markdown-style "#" lines; body is everything until
// the next heading. Text with no headings becomes one section per
// paragraph block.

import type { ExtractedSection, ExtractionResult } from "./types.js";

const HEADING_RE = /^#{1,6}\s+(.+)$/;

export function extractTextSections(text: string): ExtractionResult {
  const lines = text.split(/\r?\n/);
  const sections: ExtractedSection[] = [];

  let heading = "";
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join("\n").trim();
    if (heading || body) {
      sections.push({ heading: heading.trim(), body, pageRef: 0 });
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flush();
      heading = match[1];
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  // No headings at all — split into paragraph blocks so chunking still has
  // natural boundaries.
  if (sections.length <= 1 && sections[0]?.heading === "") {
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      sections: paragraphs.map((body) => ({ heading: "", body, pageRef: 0 })),
      pages: 1,
      ocrPages: 0,
      images: [],
    };
  }

  return { sections, pages: 1, ocrPages: 0, images: [] };
}
