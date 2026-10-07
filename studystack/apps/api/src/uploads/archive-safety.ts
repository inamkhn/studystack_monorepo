// ── F1 §6: archive-bomb + dangerous-content guard for DOCX (ZIP) ────────
// A DOCX is a ZIP container. Mammoth inflates it during parse, so a small
// upload can claim gigabytes of decompressed XML (the classic
// 5 MB → 20 GB bomb, doc §6/§40). This module inspects the ZIP *central
// directory metadata only* — it never decompresses an entry — to bound
// compressed size, total expanded size, entry count, and per-entry
// expansion ratio, and to spot known-dangerous OOXML members (macros,
// ActiveX, embedded OLE). Everything throws a stable, non-retryable
// ExtractionError so the client branches on the code (doc §36/§37).

import {
  ExtractionError,
  IngestionErrorCode,
} from "../ai/pipeline/types.js";
import {
  ARCHIVE_RATIO_MIN_ENTRY_BYTES,
  UPLOAD_MAX_ARCHIVE_ENTRIES,
  UPLOAD_MAX_COMPRESSION_RATIO,
  UPLOAD_MAX_UNCOMPRESSED_BYTES,
} from "./upload-limits.js";

// Little-endian signatures.
const EOCD_SIG = 0x06054b50; // "PK\x05\x06" end of central directory
const EOCD64_SIG = 0x06064b50; // ZIP64 end of central directory
const EOCD64_LOC_SIG = 0x07064b50; // ZIP64 EOCD locator
const CD_SIG = 0x02014b50; // "PK\x01\x02" central directory file header

export interface ArchiveInspection {
  /** Entries described by the central directory. */
  entryCount: number;
  /** Sum of compressed entry sizes (bytes). */
  compressedBytes: number;
  /** Sum of *declared* uncompressed entry sizes (bytes) — the bomb metric. */
  uncompressedBytes: number;
  /** Largest uncompressed/compressed ratio among sizeable entries. */
  maxLargeEntryRatio: number;
  /** Dangerous OOXML members present (macro/ActiveX/OLE/external data). */
  hasDangerousMember: boolean;
  /** Any entry whose name escapes the archive root (path traversal). */
  hasTraversalPath: boolean;
  /** True when a valid central directory could be walked to completion. */
  structurallySound: boolean;
}

/**
 * Reads a ZIP's central directory and aggregates the resource metrics we
 * guard on, without inflating a single byte. Returns a best-effort
 * inspection even for malformed input (with `structurallySound=false`) so
 * callers can distinguish "not a readable archive" from "a bomb".
 */
export function inspectArchive(buf: Buffer): ArchiveInspection {
  const result: ArchiveInspection = {
    entryCount: 0,
    compressedBytes: 0,
    uncompressedBytes: 0,
    maxLargeEntryRatio: 0,
    hasDangerousMember: false,
    hasTraversalPath: false,
    structurallySound: false,
  };
  if (buf.length < 22) return result;

  const eocd = findEocd(buf);
  if (eocd < 0) return result;

  let totalEntries = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 16/32-bit fields are maxed and the real values live in the
  // ZIP64 EOCD record, pointed at by the locator just before the EOCD.
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    const z64 = readZip64Record(buf, eocd);
    if (z64) {
      totalEntries = z64.totalEntries;
      cdSize = z64.cdSize;
      cdOffset = z64.cdOffset;
    }
  }

  if (cdOffset + cdSize > buf.length || cdOffset < 0) return result;

  result.entryCount = totalEntries;
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      return result; // truncated / forged central directory
    }
    let compressed = buf.readUInt32LE(p + 20);
    let uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > buf.length) return result;

    const name = buf
      .toString("utf8", p + 46, nameEnd)
      .replace(/\\/g, "/")
      .toLowerCase();

    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      const z = readZip64Extra(buf, nameEnd, extraLen, {
        compressedMaxed: compressed === 0xffffffff,
        uncompressedMaxed: uncompressed === 0xffffffff,
      });
      if (z.compressed !== null) compressed = z.compressed;
      if (z.uncompressed !== null) uncompressed = z.uncompressed;
    }

    result.compressedBytes += compressed;
    result.uncompressedBytes += uncompressed;
    if (
      uncompressed >= ARCHIVE_RATIO_MIN_ENTRY_BYTES &&
      compressed > 0
    ) {
      const ratio = uncompressed / compressed;
      if (ratio > result.maxLargeEntryRatio) result.maxLargeEntryRatio = ratio;
    }

    if (isDangerousMember(name)) result.hasDangerousMember = true;
    if (name.startsWith("../") || name.includes("/../")) {
      result.hasTraversalPath = true;
    }

    p = nameEnd + extraLen + commentLen;
  }

  result.structurallySound = true;
  return result;
}

/**
 * Enforces the archive bounds on a DOCX. Throws a non-retryable
 * ExtractionError with a stable code; returns the inspection on success.
 */
export function assertDocxArchiveSafe(buf: Buffer): ArchiveInspection {
  const info = inspectArchive(buf);

  if (!info.structurallySound) {
    throw new ExtractionError(
      IngestionErrorCode.FileCorrupted,
      "The DOCX is not a readable ZIP archive (truncated or malformed)",
      false,
    );
  }
  if (info.hasTraversalPath) {
    throw new ExtractionError(
      IngestionErrorCode.MalwareDetected,
      "The DOCX contains an archive entry with a path outside its root",
      false,
    );
  }
  if (info.hasDangerousMember) {
    throw new ExtractionError(
      IngestionErrorCode.MalwareDetected,
      "The DOCX contains an embedded macro/ActiveX/OLE object and was rejected",
      false,
    );
  }
  if (info.entryCount > UPLOAD_MAX_ARCHIVE_ENTRIES) {
    throw new ExtractionError(
      IngestionErrorCode.ArchiveBomb,
      `DOCX has ${info.entryCount} archive entries (limit ${UPLOAD_MAX_ARCHIVE_ENTRIES})`,
      false,
    );
  }
  if (info.uncompressedBytes > UPLOAD_MAX_UNCOMPRESSED_BYTES) {
    throw new ExtractionError(
      IngestionErrorCode.ArchiveBomb,
      `DOCX would expand to ${info.uncompressedBytes} bytes (limit ${UPLOAD_MAX_UNCOMPRESSED_BYTES})`,
      false,
    );
  }
  if (info.maxLargeEntryRatio > UPLOAD_MAX_COMPRESSION_RATIO) {
    throw new ExtractionError(
      IngestionErrorCode.ArchiveBomb,
      `DOCX entry expands ${Math.round(info.maxLargeEntryRatio)}× (limit ${UPLOAD_MAX_COMPRESSION_RATIO})`,
      false,
    );
  }

  return info;
}

// ── internals ───────────────────────────────────────────────────────────

/** Finds the real EOCD record, validating the comment-length → EOF link. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557); // 22 + 65535 comment max
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  return -1;
}

function readZip64Record(
  buf: Buffer,
  eocd: number,
): { totalEntries: number; cdSize: number; cdOffset: number } | null {
  const loc = eocd - 20; // locator is 20 bytes, immediately before EOCD
  if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOC_SIG) return null;
  const recOff = buf.readUInt32LE(loc + 8);
  if (recOff < 0 || recOff + 56 > buf.length) return null;
  if (buf.readUInt32LE(recOff) !== EOCD64_SIG) return null;
  return {
    totalEntries: Number(buf.readBigUInt64LE(recOff + 32)),
    cdSize: Number(buf.readBigUInt64LE(recOff + 40)),
    cdOffset: Number(buf.readBigUInt64LE(recOff + 48)),
  };
}

/**
 * Extracts the 64-bit sizes from an entry's ZIP64 extended-information
 * extra field (header id 0x0001). Fields appear only for the 32-bit values
 * that were maxed, in the order: uncompressed, compressed, (offset, disk).
 */
function readZip64Extra(
  buf: Buffer,
  extraStart: number,
  extraLen: number,
  which: { compressedMaxed: boolean; uncompressedMaxed: boolean },
): { compressed: number | null; uncompressed: number | null } {
  const out = { compressed: null as number | null, uncompressed: null as number | null };
  let e = extraStart;
  const end = extraStart + extraLen;
  while (e + 4 <= end) {
    const id = buf.readUInt16LE(e);
    const size = buf.readUInt16LE(e + 2);
    const body = e + 4;
    if (id === 0x0001) {
      let q = body;
      if (which.uncompressedMaxed && q + 8 <= buf.length) {
        out.uncompressed = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (which.compressedMaxed && q + 8 <= buf.length) {
        out.compressed = Number(buf.readBigUInt64LE(q));
      }
      return out;
    }
    e = body + size;
  }
  return out;
}

/** Known-dangerous OOXML members (macros, ActiveX, OLE, external data). */
function isDangerousMember(name: string): boolean {
  return (
    name === "word/vbaproject.bin" ||
    name.startsWith("word/activex/") ||
    name.startsWith("word/embeddings/") ||
    name.startsWith("word/externaldata") ||
    // A .docx carrying a legacy binary doc inside its word/ tree is abuse.
    name.endsWith("/vbaproject.bin")
  );
}
