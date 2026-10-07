// ── F1 upload-path limits (design doc §5) ──────────────────────────────
// Single source of truth for the pre-parse resource bounds. Consumed by
// the HTTP upload entrypoints (multer cap, presign/confirm) AND the
// ingestion worker (defensive re-check before a parser touches bytes),
// so a limit can never be enforced on one path and forgotten on another.
//
// All are env-overridable so prod can tune to real capacity without a
// code change; the fallbacks keep the documented 400+ page / 50 MB use
// case working while bounding runaway decompression (§6).

/** Safe positive-integer env read with a hard fallback (never NaN). */
function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MB = 1024 * 1024;

/** Hard per-file upload cap (compressed bytes on disk / in storage). */
export const UPLOAD_MAX_BYTES = num(process.env.UPLOAD_MAX_BYTES, 50 * MB);

/**
 * Ceiling on the sum of a ZIP's uncompressed entry sizes (doc §6). The
 * bound that actually stops a bomb: a 5 MB DOCX claiming 20 GB expanded
 * is rejected here before any parser inflates it.
 */
export const UPLOAD_MAX_UNCOMPRESSED_BYTES = num(
  process.env.UPLOAD_MAX_UNCOMPRESSED_BYTES,
  250 * MB,
);

/** Ceiling on the number of entries in a ZIP container. */
export const UPLOAD_MAX_ARCHIVE_ENTRIES = num(
  process.env.UPLOAD_MAX_ARCHIVE_ENTRIES,
  4096,
);

/**
 * Per-entry expansion ratio (uncompressed / compressed) allowed once an
 * entry is large enough for the ratio to matter. Normal DOCX boilerplate
 * (XML) compresses ~10–20×, so the guard only fires on entries ≥ 1 MB
 * that expand past this factor — the signature of a crafted bomb.
 */
export const UPLOAD_MAX_COMPRESSION_RATIO = num(
  process.env.UPLOAD_MAX_COMPRESSION_RATIO,
  100,
);

/** Entries below this expanded size are exempt from the ratio check. */
export const ARCHIVE_RATIO_MIN_ENTRY_BYTES = 1 * MB;
