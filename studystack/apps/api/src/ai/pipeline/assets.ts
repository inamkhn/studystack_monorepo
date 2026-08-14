// ── Extracted asset persistence (F1 Phase C) ───────────────────────────
// Images/diagrams pulled out of uploads are saved under
// uploads/assets/<courseId>/ so they stay linked to the course instead of
// floating loose (F1 spec step 3). save() returns a storage key relative
// to UPLOAD_DIR (see common/utils/storage.ts), not an absolute path —
// that is what gets stored in chunk metadata, keeping rows portable for
// the object-storage migration (gap doc §4.5).

import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { courseAssetsDir, toStorageKey } from "../../common/utils/storage.js";

export { ASSETS_SUBDIR } from "../../common/utils/storage.js";

/**
 * Returns a save function bound to one course's asset directory plus a
 * wipe() for retry safety (mirrors the deleteMany-before-insert pattern
 * used for source_chunks).
 */
export function createCourseAssetSaver(courseId: string): {
  save: (name: string, data: Uint8Array) => Promise<string>;
  wipe: () => Promise<void>;
  dir: string;
} {
  const dir = courseAssetsDir(courseId);

  return {
    dir,
    async save(name, data) {
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, name);
      await writeFile(filePath, data);
      return toStorageKey(filePath);
    },
    async wipe() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
