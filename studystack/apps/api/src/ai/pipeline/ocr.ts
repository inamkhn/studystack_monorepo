// ── Tesseract OCR (scanned pages) ──────────────────────────────────────
// tesseract.js (pure WASM, no native install). OCR is CPU-heavy and can
// hang on malformed/huge scans, so it is bounded three ways (doc §17):
//   1. per-page wall-clock timeout — a stuck recognize() rejects and the
//      worker is recycled rather than blocking the whole ingestion job;
//   2. recycle-on-error — a worker that throws is terminated and rebuilt
//      fresh for the next page (an unhealthy WASM instance is not reused);
//   3. periodic recycle — every OCR_RECYCLE_AFTER_PAGES pages the worker is
//      torn down to reclaim the WASM heap a long run leaks.
// English by default; the detected course language is a future refinement.

import { createWorker, type Worker } from "tesseract.js";
import {
  OCR_PAGE_TIMEOUT_MS,
  OCR_RECYCLE_AFTER_PAGES,
} from "./types.js";

let workerPromise: Promise<Worker> | null = null;
let pagesSinceRecycle = 0;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
    workerPromise.catch(() => {
      workerPromise = null; // allow retry after a failed init
    });
  }
  return workerPromise;
}

/** Tear down the current worker so the next getWorker() builds a fresh one. */
async function recycleWorker(): Promise<void> {
  const current = workerPromise;
  workerPromise = null;
  pagesSinceRecycle = 0;
  if (!current) return;
  try {
    (await current).terminate();
  } catch {
    // Best-effort teardown — a stuck worker is abandoned either way.
  }
}

/** Rejects after `ms`; the timer is cleared by withTimeout's finally block. */
function delay(ms: number): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`OCR page timed out after ${ms}ms`)),
      ms,
    );
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * OCRs an image buffer to plain text. Throws on engine failure or page
 * timeout; either way the worker is recycled so a later page starts clean.
 */
export async function ocrImage(image: Uint8Array): Promise<string> {
  const worker = await getWorker();
  const timer = delay(OCR_PAGE_TIMEOUT_MS);
  try {
    const { data } = await Promise.race([worker.recognize(image), timer.promise]);
    if (++pagesSinceRecycle >= OCR_RECYCLE_AFTER_PAGES) {
      await recycleWorker();
    }
    return data.text;
  } catch (error) {
    // Unhealthy or timing-out worker — drop it before the next page.
    await recycleWorker();
    throw error;
  } finally {
    timer.cancel();
  }
}
