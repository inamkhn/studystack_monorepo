// ── Upload file validation (F1) ────────────────────────────────────────
// Spec allows PDF, DOCX, and plain text only. Extension alone is not
// trusted — the buffer's magic bytes must agree with the claimed
// extension, otherwise a corrupted/disguised file would create a course
// that parks in `ingesting` forever (F1 edge case: "surface a clear
// error; don't create an empty course silently").

import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { open } from "node:fs/promises";
import * as path from "path";

export type UploadFileKind = "pdf" | "docx" | "text";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — DOCX is a zip container

const EXTENSION_KIND: Record<string, UploadFileKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "text",
  ".md": "text",
};

function matchesMagic(buffer: Buffer, magic: number[]): boolean {
  return buffer.length >= magic.length && magic.every((b, i) => buffer[i] === b);
}

/**
 * Text heuristic: no NUL bytes and no C0 control chars other than
 * tab/newline/CR in the sampled head. Enough to reject binaries.
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, 8192);
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return false;
    }
  }
  return true;
}

/** Content-sniffed kind of a buffer, or null when unrecognizable. */
export function sniffFileKind(buffer: Buffer): UploadFileKind | null {
  if (matchesMagic(buffer, PDF_MAGIC)) return "pdf";
  if (matchesMagic(buffer, ZIP_MAGIC)) return "docx";
  if (looksLikeText(buffer)) return "text";
  return null;
}

/**
 * Validates an upload's extension against its actual content.
 * Throws 400 for a missing file, 415 for a wrong type or mismatch.
 */
export function validateUploadFile(file: {
  originalname?: string;
  buffer?: Buffer;
}): UploadFileKind {
  if (!file?.buffer?.length) {
    throw new BadRequestException("A file upload is required");
  }

  const ext = path.extname(file.originalname ?? "").toLowerCase();
  const claimed = EXTENSION_KIND[ext];
  if (!claimed) {
    throw new UnsupportedMediaTypeException(
      "Only PDF, DOCX, and plain-text (.txt / .md) files are supported",
    );
  }

  const actual = sniffFileKind(file.buffer);
  if (actual !== claimed) {
    throw new UnsupportedMediaTypeException(
      `File content does not match its "${ext}" extension — the upload appears corrupted or mislabelled`,
    );
  }

  return claimed;
}

/** Read the first bytes of a file without buffering the whole upload. */
export async function readFileHead(
  filePath: string,
  length: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Path-based variant for disk-streamed uploads (multer diskStorage): the
 * file is on disk, so sniff its head instead of an in-memory buffer.
 * Same 400/415 contract as validateUploadFile.
 */
export async function validateUploadFilePath(
  filePath: string,
  originalname: string,
): Promise<UploadFileKind> {
  const ext = path.extname(originalname ?? "").toLowerCase();
  const claimed = EXTENSION_KIND[ext];
  if (!claimed) {
    throw new UnsupportedMediaTypeException(
      "Only PDF, DOCX, and plain-text (.txt / .md) files are supported",
    );
  }

  const head = await readFileHead(filePath, 8192);
  const actual = head.length > 0 ? sniffFileKind(head) : null;
  if (actual !== claimed) {
    throw new UnsupportedMediaTypeException(
      `File content does not match its "${ext}" extension — the upload appears corrupted or mislabelled`,
    );
  }

  return claimed;
}
