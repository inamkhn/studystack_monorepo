// ── Chunking + section analysis (F1 Phase A) ───────────────────────────
// Turns extracted sections into SourceChunk-ready rows:
//   1. Flag headed sections whose body is too thin → needsResearchFill
//      (F1 spec: empty/placeholder sections get priority-2 research
//      backfill later).
//   2. Split long bodies into ~CHUNK_TARGET_WORDS chunks on sentence
//      boundaries with word overlap, keeping heading + pageRef context.

import {
  CHUNK_HARD_MAX_WORDS,
  CHUNK_OVERLAP_WORDS,
  CHUNK_TARGET_WORDS,
  MIN_SECTION_BODY_WORDS,
  type ExtractedSection,
} from "./types.js";

export interface ChunkDraft {
  chunkText: string;
  /** JSON for source_chunks.metadata: heading/page provenance. */
  metadata: {
    heading: string | null;
    pageRef: number | null;
    ocr: boolean;
    sectionIndex: number;
    chunkIndex: number;
    /**
     * Phase C — absolute paths of figures linked to this chunk's section
     * (F1 spec: images stay linked to their source section). Filled by
     * the ingestion processor after asset persistence; chunker itself
     * leaves it undefined.
     */
    images?: string[];
  };
  needsResearchFill: boolean;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Splits text on sentence boundaries into groups of roughly `target`
 * words. Consecutive groups overlap by `overlap` words so context at
 * boundaries isn't lost for retrieval.
 */
function splitIntoChunks(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join(" "));
    current = [];
    words = 0;
  };

  for (const sentence of sentences) {
    const sw = wordCount(sentence);
    // Oversized single sentence — hard-split by words.
    if (sw > CHUNK_HARD_MAX_WORDS) {
      flush();
      const ws = sentence.split(/\s+/);
      for (let i = 0; i < ws.length; i += CHUNK_TARGET_WORDS) {
        chunks.push(ws.slice(i, i + CHUNK_TARGET_WORDS).join(" "));
      }
      continue;
    }
    if (words + sw > CHUNK_TARGET_WORDS && current.length) {
      flush();
      // overlap: carry the tail of the previous chunk forward
      const prev = chunks[chunks.length - 1]?.split(/\s+/) ?? [];
      const tail = prev.slice(-CHUNK_OVERLAP_WORDS);
      if (tail.length) {
        current = tail;
        words = tail.length;
      }
    }
    current.push(sentence);
    words += sw;
  }
  flush();

  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

export function buildChunks(sections: ExtractedSection[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];

  sections.forEach((section, sectionIndex) => {
    const bodyWords = wordCount(section.body);
    const thin =
      section.heading !== "" && bodyWords < MIN_SECTION_BODY_WORDS;

    if (thin) {
      // Keep whatever exists (heading + short body) as a flagged chunk so
      // research backfill has an anchor to fill.
      drafts.push({
        chunkText: `${section.heading}\n${section.body}`.trim(),
        metadata: {
          heading: section.heading,
          pageRef: section.pageRef || null,
          ocr: section.ocr === true,
          sectionIndex,
          chunkIndex: 0,
        },
        needsResearchFill: true,
      });
      return;
    }

    const parts = splitIntoChunks(section.body);
    parts.forEach((chunkText, chunkIndex) => {
      // Prefix heading on the first chunk of each section so retrieval
      // hits carry topical context.
      const text =
        chunkIndex === 0 && section.heading
          ? `${section.heading}\n${chunkText}`
          : chunkText;
      drafts.push({
        chunkText: text,
        metadata: {
          heading: section.heading || null,
          pageRef: section.pageRef || null,
          ocr: section.ocr === true,
          sectionIndex,
          chunkIndex,
        },
        needsResearchFill: false,
      });
    });
  });

  return drafts;
}
