// ── Tesseract OCR (scanned pages) ──────────────────────────────────────
// tesseract.js (pure WASM, no native install). The worker is created once
// and reused across pages; language-data downloads are cached by
// tesseract.js itself. English by default — the detected course language
// is a future refinement once language feeds the pipeline.

import { createWorker, type Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
    workerPromise.catch(() => {
      workerPromise = null; // allow retry after a failed init
    });
  }
  return workerPromise;
}

/** OCRs an image buffer to plain text. Throws on engine failure. */
export async function ocrImage(image: Uint8Array): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(image);
  return data.text;
}
