// ── Storage path handling (F1 §4.5 hardening) ──────────────────────────
// Uploaded files and extracted assets live as absolute process.cwd()-based
// paths in the DB, which breaks on S3/R2 migration, on runners whose cwd
// differs from `nest start`, and outright on multi-instance deploys.
//
// Contract now: everything stored in the DB (`source_documents.fileUrl`,
// `source_chunks.metadata.images`) is a *storage key relative to
// UPLOAD_DIR*, forward-slash normalized. Legacy absolute paths still
// resolve via resolveStoredPath, so existing rows keep working. A future
// object-storage swap replaces this module, not every call site.

import { rm } from "node:fs/promises";
import * as path from "node:path";

/** Local upload root — stand-in until object storage (S3/R2) is wired. */
export const UPLOAD_DIR = path.join(process.cwd(), "uploads");

/** Extracted figures live under uploads/assets/<courseId>/. */
export const ASSETS_SUBDIR = "assets";

/** Convert an absolute on-disk path to the storable relative key. */
export function toStorageKey(absPath: string): string {
  return path.relative(UPLOAD_DIR, absPath).split(path.sep).join("/");
}

/**
 * Resolve a stored value back to a local path. Relative keys are joined
 * onto UPLOAD_DIR; legacy absolute paths pass through unchanged.
 */
export function resolveStoredPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(UPLOAD_DIR, stored);
}

/** On-disk directory holding one course's extracted figures. */
export function courseAssetsDir(courseId: string): string {
  return path.join(UPLOAD_DIR, ASSETS_SUBDIR, courseId);
}

/** Remove one course's extracted figures (course deletion / retry wipe). */
export async function deleteCourseAssets(courseId: string): Promise<void> {
  await rm(courseAssetsDir(courseId), { recursive: true, force: true });
}
