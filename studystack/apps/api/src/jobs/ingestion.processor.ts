// ── F1 ingestion worker — Phase 2: bounded, resumable extraction ───────
// Jobs extract pages in PAGE_BATCH_SIZE windows under a per-job budget
// (MAX_PAGES_PER_JOB); each batch checkpoints the document's IngestionRun
// (pagesProcessed), and a job that runs out of budget re-enqueues a
// continuation. A worker crash or restart therefore resumes at the last
// committed page instead of restarting the document at page 1
// (design doc §26/§38/§43).
//
//   job(courseId) → pick next pending document (DB-derived)
//     → extract one page window → persist chunks + assets
//     → checkpoint run.pagesProcessed → (budget left? next window :
//       continuation job …)
//     → when no documents remain: embedding + convergence (finalizer)
//
// Chunk identity (doc §22): every row carries a document-scoped
// chunkOrdinal, SHA-256 contentHash, and pipelineVersion. Figures are
// persisted as SourceAsset rows (doc §9) alongside their storage keys.
//
// The F1 failure contract is preserved: a document that needs user action
// (password-protected, over page limit, corrupted) fails with a stable
// code and its run stops being retried; the course only fails when no
// document yields content at all.

import { Logger } from "@nestjs/common";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { createHash } from "node:crypto";
import * as path from "path";
import { sniffFileKind } from "../common/utils/file-validation.js";
import { withChunkScope } from "../common/utils/chunk-scope.js";
import { StorageService } from "../storage/storage.service.js";
import { UploadValidationService } from "../uploads/upload-validation.service.js";
import {
  METRICS,
  IngestionTelemetry,
  type CorrelationIds,
} from "../observability/ingestion-telemetry.js";
import {
  buildChunks,
  ExtractionError,
  extractDocxSections,
  extractPdfPageWindow,
  extractTextSections,
  INGESTION_PIPELINE_VERSION,
  IngestionErrorCode,
  MAX_OCR_PAGES,
  MAX_PAGES_PER_JOB,
  PAGE_BATCH_SIZE,
  type ChunkDraft,
  type ExtractedImage,
  type ExtractionResult,
  type PdfPageWindowResult,
} from "../ai/pipeline/index.js";
import { embedCourseChunks } from "../ai/pipeline/embedder.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ExtractionStatus,
  IngestionStage,
  Prisma,
} from "../generated/prisma/client.js";
import { INGESTION_QUEUE, JOB_PRIORITY, STRUCTURING_QUEUE } from "./jobs.constants.js";

/** Chunk rows are persisted in batches to keep memory bounded on big docs. */
const CHUNK_INSERT_BATCH = 200;

/** One document's worth of extraction output, pre-persistence. */
interface BatchContent {
  sections: PdfPageWindowResult["sections"];
  images: ExtractedImage[];
  /** Pages covered by this batch; null for pageless formats (whole file). */
  window: { startPage: number; endPage: number } | null;
  pageCount: number | null;
  ocrPages: number;
  /** Wall-clock OCR spent in this batch (ms); 0 for pageless formats. */
  ocrMs: number;
}

/**
 * Accumulated per-document extraction/persist tallies, written to the
 * run's `metrics` JSON at completion and merged across continuation jobs
 * (§41/§42 — queryable operational history without log scraping).
 */
interface RunTally {
  pagesProcessed: number;
  ocrPages: number;
  ocrMs: number;
  extractionMs: number;
  persistMs: number;
  chunksWritten: number;
  assetsWritten: number;
  needsResearchFill: number;
}

function newTally(): RunTally {
  return {
    pagesProcessed: 0,
    ocrPages: 0,
    ocrMs: 0,
    extractionMs: 0,
    persistMs: 0,
    chunksWritten: 0,
    assetsWritten: 0,
    needsResearchFill: 0,
  };
}

/** What one commitBatch persisted, for the caller to tally + report. */
interface PersistedSummary {
  chunks: number;
  assets: number;
  needsResearchFill: number;
}

/** Per-job extraction budget, mutable so nested helpers can spend it. */
interface JobBudget {
  pagesUsed: number;
  readonly max: number;
}

type RunRecord = {
  id: string;
  pagesProcessed: number;
  attempt: number;
};

type DocumentRecord = {
  id: string;
  courseId: string;
  fileUrl: string | null;
  fileType: string | null;
  pageCount: number | null;
};

@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
    @InjectQueue(STRUCTURING_QUEUE) private readonly structuringQueue: Queue,
    private readonly storage: StorageService,
    private readonly uploads: UploadValidationService,
    private readonly telemetry: IngestionTelemetry,
  ) {
    super();
  }

  async process(job: Job<{ courseId: string }>): Promise<void> {
    const { courseId } = job.data;
    const ids: CorrelationIds = {
      courseId,
      pipelineVersion: INGESTION_PIPELINE_VERSION,
    };
    const startedAt = performance.now();
    const beganAt = job.processedOn ?? Date.now();
    if (typeof job.timestamp === "number" && beganAt > job.timestamp) {
      this.telemetry.observe(
        METRICS.queueWaitSeconds,
        (beganAt - job.timestamp) / 1000,
      );
    }
    this.telemetry.logEvent("log", "ingestCourse:start", ids);
    // "noop" ⇒ deleted mid-flight or a retryable error re-thrown for BullMQ;
    // neither is a real ingestion outcome, so neither is counted.
    let outcome: "success" | "failure" | "handoff" | "noop" = "noop";

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) return; // deleted mid-flight

    try {
      // ── Extraction: page batches under a per-job page budget ────────
      const budget: JobBudget = { pagesUsed: 0, max: MAX_PAGES_PER_JOB };
      let handedOff = false;
      for (;;) {
        const pending = await this.pendingDocuments(courseId);
        if (pending.length === 0) break;

        const document = pending[0];
        try {
          await this.processDocument(job, courseId, document, budget);
        } catch (error) {
          const classified = this.classifyDocumentError(error, document.id);
          if (classified.retryable) throw classified; // let BullMQ retry
          await this.failDocument(courseId, document, classified);
          this.telemetry.logEvent("warn", "document:failed", {
            courseId,
            sourceDocumentId: document.id,
            pipelineVersion: INGESTION_PIPELINE_VERSION,
          }, { code: classified.code });
        }
        if (budget.pagesUsed >= budget.max) {
          // Budget spent — checkpoint is durable, so hand off to a
          // continuation job instead of finalizing with documents left.
          await this.handoffContinuation(courseId, document.id);
          handedOff = true;
          break;
        }
      }
      if (handedOff) {
        outcome = "handoff";
        return;
      }

      // ── Finalize: no documents left pending ──────────────────────────
      const readyCount = await this.prisma.sourceDocument.count({
        where: { courseId, extractionStatus: "ready" },
      });
      if (readyCount === 0) {
        await this.failCourse(
          courseId,
          "No readable content could be extracted from the uploaded file(s)",
        );
        outcome = "failure";
        return;
      }

      // Embeddings are idempotent — only rows without a vector are
      // embedded. Recoverable, not fatal: without a Gateway key (or during
      // a provider outage) chunks stay unembedded and the course still
      // converges; the gap can be filled later by a re-run.
      await this.setStage(courseId, "embedding");
      const embedSpan = this.telemetry.span("embedChunks", ids);
      let embeddedCount = 0;
      try {
        embeddedCount = await embedCourseChunks(this.prisma, courseId);
        // One provider round-trip per course embed (embedder batches
        // internally) — count it as a single embedding batch (§41).
        if (embeddedCount > 0) this.telemetry.increment(METRICS.embeddingBatches);
      } catch (error) {
        this.telemetry.increment(METRICS.embeddingFailure);
        this.logger.warn(
          `embedding stage skipped for course ${courseId} (recoverable): ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
      embedSpan.end({ embedded: embeddedCount });

      // Convergence (F3). Intake recorded → F4 structuring job; otherwise
      // park at intake_pending until goal+level arrive.
      const courseRow = await this.prisma.course.findUnique({
        where: { id: courseId },
        select: { goal: true, level: true },
      });
      const intakeRecorded = Boolean(courseRow?.goal && courseRow?.level);

      if (intakeRecorded) {
        await this.prisma.course.update({
          where: { id: courseId },
          data: { status: "structuring", ingestionStage: "structuring" },
        });
        await this.structuringQueue.add(
          "structure-course",
          { courseId },
          {
            priority: JOB_PRIORITY.newCourseIngestion,
            jobId: `structure:${courseId}`,
            attempts: 2,
            backoff: { type: "exponential", delay: 15_000 },
          },
        );
      } else {
        await this.prisma.course.update({
          where: { id: courseId },
          data: { status: "intake_pending", ingestionStage: null },
        });
      }

      const chunkCount = await this.prisma.sourceChunk.count({ where: { courseId } });
      this.telemetry.logEvent("log", "ingestCourse:complete", ids, {
        chunks: chunkCount,
        documentsReady: readyCount,
        embedded: embeddedCount,
        convergedTo: intakeRecorded ? "structuring" : "intake_pending",
      });
      outcome = "success";
    } catch (error) {
      if (error instanceof ExtractionError && error.retryable) throw error;
      // Unexpected failure outside a classified document error — honor the
      // F1 contract: fail the course rather than strand it. Mirrors
      // CourseMaintenanceService.failCourseIngestion (not imported to
      // avoid a JobsModule ↔ CourseModule cycle).
      const reason =
        error instanceof Error ? error.message : "Source file unreadable";
      this.telemetry.logEvent("error", "ingestCourse:failed", ids, { reason });
      await this.failCourse(courseId, reason);
      outcome = "failure";
    } finally {
      // Record the job-level duration + outcome once, at every exit. A
      // re-thrown retryable error leaves outcome "noop" (BullMQ retries).
      if (outcome !== "noop") {
        const durationSec = (performance.now() - startedAt) / 1000;
        this.telemetry.observe(METRICS.ingestionDurationSeconds, durationSec);
        if (outcome === "success") this.telemetry.increment(METRICS.ingestionSuccess);
        else if (outcome === "failure") this.telemetry.increment(METRICS.ingestionFailure);
      }
    }
  }

  // ── per-document batch pipeline ──────────────────────────────────────

  /**
   * Documents awaiting work. Ready/failed are terminal for the pass; a
   * resumed job re-enters the interrupted document through its run
   * checkpoint, so "extracting" stays pending.
   */
  private async pendingDocuments(courseId: string): Promise<DocumentRecord[]> {
    return this.prisma.sourceDocument.findMany({
      where: {
        courseId,
        fileUrl: { not: null },
        extractionStatus: { notIn: ["ready", "failed"] },
      },
      orderBy: { uploadedAt: "asc" },
    });
  }

  private async processDocument(
    job: Job<{ courseId: string }>,
    courseId: string,
    document: DocumentRecord,
    budget: JobBudget,
  ): Promise<void> {
    const ids: CorrelationIds = {
      courseId,
      sourceDocumentId: document.id,
      pipelineVersion: INGESTION_PIPELINE_VERSION,
    };
    const raw = await this.loadVerified(document);
    const kind = (document.fileType ?? path.extname(document.fileUrl!)).toLowerCase();

    let run = await this.currentRun(document.id);
    if (!run) run = await this.startRun(courseId, document.id);
    ids.ingestionRunId = run.id;

    // Fresh run → this document's previous outputs are stale; wipe its
    // chunks and asset rows/files before appending (doc §38 retry safety).
    if (run.pagesProcessed === 0) {
      await this.wipeDocumentOutput(courseId, document.id);
    }

    const tally = newTally();

    if (kind === ".pdf") {
      // Walk page windows until this document is done or the job's page
      // budget is spent — the caller then hands off to a continuation,
      // and a resume after a crash re-enters at the run checkpoint.
      for (;;) {
        const startPage = run.pagesProcessed + 1;
        const extractSpan = this.telemetry.span("extractPages", ids);
        const batch = await this.batchWindow(
          raw,
          document,
          run,
          startPage,
          PAGE_BATCH_SIZE,
        );
        const extractionMs = extractSpan.end(
          batch
            ? {
                startPage,
                endPage: batch.window!.endPage,
                ocrPages: batch.ocrPages,
              }
            : { startPage, empty: true },
        );
        if (!batch) break; // fully covered — run completed by an earlier pass
        tally.extractionMs += extractionMs;

        const persistStart = performance.now();
        const persisted = await this.commitBatch(courseId, document, run, batch);
        tally.persistMs += performance.now() - persistStart;
        const pages = batch.window!.endPage - batch.window!.startPage + 1;
        tally.pagesProcessed += pages;
        tally.ocrPages += batch.ocrPages;
        tally.ocrMs += batch.ocrMs;
        tally.chunksWritten += persisted.chunks;
        tally.assetsWritten += persisted.assets;
        tally.needsResearchFill += persisted.needsResearchFill;

        this.telemetry.increment(METRICS.pagesProcessed, pages);
        if (batch.ocrPages > 0) {
          this.telemetry.increment(METRICS.pagesOcr, batch.ocrPages);
          this.telemetry.observe(METRICS.ocrDurationSeconds, batch.ocrMs / 1000);
        }

        run = await this.prisma.ingestionRun.update({
          where: { id: run.id },
          data: { pagesProcessed: { increment: pages } },
          select: { id: true, pagesProcessed: true, attempt: true },
        });
        ids.ingestionRunId = run.id;
        budget.pagesUsed += pages;
        await this.checkpointProgress(job, courseId, document, run, batch.pageCount!);
        if (batch.window!.endPage >= batch.pageCount!) {
          // Document done: terminal status + run completion. The caller
          // re-checks pending documents before finalizing the course.
          await this.finalizeDocument(courseId, document.id, tally);
          await this.completeRun(run.id, tally);
          break;
        }
        if (budget.pagesUsed >= budget.max) break;
      }
    } else {
      const extractSpan = this.telemetry.span("extractDocument", ids);
      const batch = await this.batchWhole(document, run, raw, kind);
      tally.extractionMs += extractSpan.end({ sections: batch.sections.length });

      const persistStart = performance.now();
      const persisted = await this.commitBatch(courseId, document, run, batch);
      tally.persistMs += performance.now() - persistStart;
      tally.pagesProcessed += 1;
      tally.ocrPages += batch.ocrPages;
      tally.chunksWritten += persisted.chunks;
      tally.assetsWritten += persisted.assets;
      tally.needsResearchFill += persisted.needsResearchFill;
      this.telemetry.increment(METRICS.pagesProcessed, 1);

      await this.finalizeDocument(courseId, document.id, tally);
      await this.completeRun(run.id, tally);
    }

    await job.updateProgress({
      stage: "extracting",
      documentId: document.id,
      courseId,
    });
  }

  /**
   * Document reached `ready`: stamp terminal status and record the
   * chunks_per_document distribution (§41) from the authoritative DB count
   * so a resumed document across continuation jobs reports the true total.
   */
  private async finalizeDocument(
    courseId: string,
    documentId: string,
    tally: RunTally,
  ): Promise<void> {
    await this.setDocumentStatus(documentId, "ready");
    const chunks = await this.prisma.sourceChunk.count({
      where: { sourceDocumentId: documentId },
    });
    this.telemetry.observe(METRICS.chunksPerDocument, chunks, undefined);
    // A completed-but-empty document is a real extraction failure to track:
    // OCR'd pages that yielded no text point at ocr_failure; otherwise it
    // was the parser (§41 failure rates).
    if (chunks === 0) {
      this.telemetry.increment(
        tally.ocrPages > 0 ? METRICS.ocrFailure : METRICS.parserFailure,
      );
    }
    this.telemetry.logEvent("log", "document:ready", {
      courseId,
      sourceDocumentId: documentId,
      pipelineVersion: INGESTION_PIPELINE_VERSION,
    }, {
      pagesProcessed: tally.pagesProcessed,
      ocrPages: tally.ocrPages,
      chunksWritten: tally.chunksWritten,
      assetsWritten: tally.assetsWritten,
    });
  }

  /**
   * Re-enqueues a continuation for the same course from its durable
   * checkpoint. jobId = (runId, pagesProcessed) — unique per batch slot
   * (completed jobIds linger in Redis), while a duplicate add of the
   * same slot dedupes (stalled-redelivery race). Single in-process
   * worker ⇒ the sliding window stays at one job in flight.
   */
  private async handoffContinuation(
    courseId: string,
    documentId: string,
  ): Promise<void> {
    const run = await this.prisma.ingestionRun.findFirst({
      where: { sourceDocumentId: documentId, status: "running" },
      orderBy: { createdAt: "desc" },
      select: { id: true, pagesProcessed: true },
    });
    const slot = run ? `${run.id}:${run.pagesProcessed}` : `${Date.now()}`;
    try {
      await this.ingestionQueue.add(
        "ingest-course",
        { courseId },
        {
          priority: JOB_PRIORITY.newCourseIngestion,
          jobId: `ingest:${courseId}:${slot}`,
        },
      );
    } catch {
      // Duplicate slot means the continuation already exists — nothing
      // to do. Any other Redis failure is covered by the reconcile sweep.
    }
  }

  /**
   * Extracts one PDF page window and turns it into a persistable batch.
   * Returns null when the document is already fully covered (the caller
   * completes the run).
   */
  private async batchWindow(
    raw: Buffer,
    document: DocumentRecord,
    run: RunRecord,
    startPage: number,
    pageSize: number,
  ): Promise<BatchContent | null> {
    if (startPage > (document.pageCount ?? 0)) return null;
    const ocrBudget = await this.ocrPagesSoFar(document.id);

    let result: PdfPageWindowResult;
    try {
      result = await extractPdfPageWindow(
        raw,
        startPage,
        pageSize,
        Math.max(0, MAX_OCR_PAGES - ocrBudget),
      );
    } catch (error) {
      if (error instanceof ExtractionError && !error.retryable) {
        this.telemetry.increment(METRICS.parserFailure);
        await this.failRun(run.id, error.code, error.message);
      }
      throw error;
    }

    // First window of the run stamps the document's page count.
    if (document.pageCount === null) {
      document.pageCount = result.pageCount;
      await this.prisma.sourceDocument
        .update({
          where: { id: document.id },
          data: { pageCount: result.pageCount },
        })
        .catch(() => undefined);
    }

    return {
      sections: result.sections,
      images: result.images,
      window: { startPage: result.startPage, endPage: result.endPage },
      pageCount: result.pageCount,
      ocrPages: result.ocrPages,
      ocrMs: result.ocrMs,
    };
  }

  /** Whole-file batch for pageless formats (DOCX/TXT/MD) — one pass. */
  private async batchWhole(
    document: DocumentRecord,
    run: RunRecord,
    raw: Buffer,
    kind: string,
  ): Promise<BatchContent> {
    let result: ExtractionResult;
    try {
      result =
        kind === ".docx"
          ? await extractDocxSections(raw)
          : extractTextSections(raw.toString("utf8"));
    } catch (error) {
      // Parsers here are pure-CPU and deterministic — a throw is a bad
      // file, not a transient fault.
      this.telemetry.increment(METRICS.parserFailure);
      const classified = new ExtractionError(
        IngestionErrorCode.ParserFailed,
        `Parsing failed for document ${document.id}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        false,
      );
      await this.failRun(run.id, classified.code, classified.message);
      throw classified;
    }

    if (result.sections.length === 0) {
      this.telemetry.increment(METRICS.parserFailure);
      const empty = new ExtractionError(
        IngestionErrorCode.ParserFailed,
        `No extractable content in document ${document.id}`,
        false,
      );
      await this.failRun(run.id, empty.code, empty.message);
      throw empty;
    }

    await this.prisma.sourceDocument
      .update({ where: { id: document.id }, data: { pageCount: 1 } })
      .catch(() => undefined);

    return {
      sections: result.sections,
      images: result.images,
      window: null,
      pageCount: 1,
      ocrPages: result.ocrPages,
      ocrMs: 0,
    };
  }

  /** Persists one batch: assets first, then chunks carrying asset paths. */
  private async commitBatch(
    courseId: string,
    document: DocumentRecord,
    run: RunRecord,
    batch: BatchContent,
  ): Promise<PersistedSummary> {
    const ids: CorrelationIds = {
      courseId,
      sourceDocumentId: document.id,
      ingestionRunId: run.id,
      pipelineVersion: INGESTION_PIPELINE_VERSION,
    };

    const persistSpan = this.telemetry.span("persistAssets", ids);
    const saved = await this.persistImages(courseId, document, run, batch.images);
    if (saved.length > 0) {
      this.telemetry.increment(METRICS.assetsWritten, saved.length, { courseId });
    }
    persistSpan.end({ assets: saved.length });

    const chunkSpan = this.telemetry.span("chunkDocument", ids);
    const drafts = buildChunks(batch.sections);
    if (batch.window) {
      // Window-local section indexes would collide across batches — shift
      // by the document's already-persisted section count so metadata
      // stays globally meaningful. chunkOrdinal is DB-derived, so a
      // re-run of an interrupted batch can't collide on the unique index.
      const offset = await this.prisma.sourceChunk.count({
        where: { sourceDocumentId: document.id },
      });
      for (const draft of drafts) draft.metadata.sectionIndex += offset;
    }

    if (saved.length > 0) {
      for (const draft of drafts) {
        const linked = saved.filter((image) =>
          image.sectionIndex !== null
            ? image.sectionIndex === draft.metadata.sectionIndex
            : image.pageRef !== 0 && image.pageRef === draft.metadata.pageRef,
        );
        if (linked.length > 0) {
          draft.metadata.images = linked.map((image) => image.path);
        }
      }
    }

    const needsResearchFill = drafts.filter(
      (draft) => draft.needsResearchFill,
    ).length;
    if (drafts.length > 0) {
      await this.appendChunks(courseId, document.id, drafts);
    }
    if (needsResearchFill > 0) {
      this.telemetry.increment(METRICS.needsResearchFillFlagged, needsResearchFill, {
        courseId,
      });
    }
    chunkSpan.end({ chunks: drafts.length, needsResearchFill });
    return {
      chunks: drafts.length,
      assets: saved.length,
      needsResearchFill,
    };
  }

  // ── run bookkeeping ──────────────────────────────────────────────────

  /** The document's resumable run, if one is still active. */
  private async currentRun(documentId: string): Promise<RunRecord | null> {
    return this.prisma.ingestionRun.findFirst({
      where: { sourceDocumentId: documentId, status: "running" },
      orderBy: { createdAt: "desc" },
      select: { id: true, pagesProcessed: true, attempt: true },
    });
  }

  private async startRun(courseId: string, documentId: string): Promise<RunRecord> {
    const priorAttempts = await this.prisma.ingestionRun.count({
      where: { sourceDocumentId: documentId },
    });
    return this.prisma.ingestionRun.create({
      data: {
        courseId,
        sourceDocumentId: documentId,
        status: "running",
        stage: "extracting",
        pipelineVersion: INGESTION_PIPELINE_VERSION,
        ocrVersion: "tesseract.js",
        attempt: priorAttempts + 1,
        startedAt: new Date(),
      },
      select: { id: true, pagesProcessed: true, attempt: true },
    });
  }

  /**
   * Durable checkpoint per batch. Also bumps course.updatedAt via
   * ingestionStage so reconcile never mistakes a live continuation chain
   * for a stranded course.
   */
  private async checkpointProgress(
    job: Job<{ courseId: string }>,
    courseId: string,
    document: DocumentRecord,
    run: RunRecord,
    pageCount: number,
  ): Promise<void> {
    const fresh = await this.prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        stage: "extracting",
        progress: Math.min(
          99,
          Math.round((run.pagesProcessed / Math.max(1, pageCount)) * 100),
        ),
      },
      select: { pagesProcessed: true },
    });
    await this.prisma.course
      .update({ where: { id: courseId }, data: { ingestionStage: "extracting" } })
      .catch(() => undefined); // course may have been deleted meanwhile
    await job
      .updateProgress({
        stage: "extracting",
        documentId: document.id,
        pagesProcessed: fresh.pagesProcessed,
        pagesTotal: pageCount,
      })
      .catch(() => undefined);
  }

  private async failRun(
    runId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.prisma.ingestionRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          stage: "failed",
          errorCode: code,
          errorMessage: message,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  /** Marks a run completed (final pageless pass writes pagesProcessed=1). */
  private async completeRun(runId: string, tally?: RunTally): Promise<void> {
    // Merge cumulative tallies across a document's continuation jobs so the
    // run row reports the whole document's cost (§41/§42 operational
    // history), not just the last job's slice.
    let metrics: Prisma.InputJsonObject | undefined;
    if (tally) {
      const existing = await this.prisma.ingestionRun
        .findUnique({ where: { id: runId }, select: { metrics: true } })
        .catch(() => null);
      const prev = (existing?.metrics ?? {}) as Record<string, number>;
      metrics = {
        pagesProcessed: (prev.pagesProcessed ?? 0) + tally.pagesProcessed,
        ocrPages: (prev.ocrPages ?? 0) + tally.ocrPages,
        ocrMs: Math.round((prev.ocrMs ?? 0) + tally.ocrMs),
        extractionMs: Math.round((prev.extractionMs ?? 0) + tally.extractionMs),
        persistMs: Math.round((prev.persistMs ?? 0) + tally.persistMs),
        chunksWritten: (prev.chunksWritten ?? 0) + tally.chunksWritten,
        assetsWritten: (prev.assetsWritten ?? 0) + tally.assetsWritten,
        needsResearchFill: (prev.needsResearchFill ?? 0) + tally.needsResearchFill,
      };
    }
    await this.prisma.ingestionRun
      .update({
        where: { id: runId },
        data: {
          status: "completed",
          stage: "completed",
          progress: 100,
          completedAt: new Date(),
          ...(metrics ? { metrics } : {}),
        },
      })
      .catch(() => undefined);
  }

  /**
   * Non-retryable document failure: terminal status + the run stops being
   * resumable (pagesProcessed keeps the audit trail of how far it got).
   */
  private async failDocument(
    courseId: string,
    document: DocumentRecord,
    error: ExtractionError,
  ): Promise<void> {
    await this.setDocumentStatus(document.id, "failed", error.code, error.message);
    await this.prisma.ingestionRun
      .updateMany({
        where: { sourceDocumentId: document.id, status: "running" },
        data: {
          status: "failed",
          stage: "failed",
          errorCode: error.code,
          errorMessage: error.message,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
    // Course-wide runs (sourceDocumentId null) would belong to a later
    // phase; per-document runs cover everything the batch loop creates.
    void courseId;
  }

  // ── stage helpers ─────────────────────────────────────────────────────

  private async setStage(courseId: string, stage: string): Promise<void> {
    await this.prisma.course
      .update({ where: { id: courseId }, data: { ingestionStage: stage } })
      .catch(() => undefined); // course may have been deleted meanwhile
  }

  /** ExtractionStatus enum values actually written by this worker (doc §8). */
  private async setDocumentStatus(
    id: string,
    status: "extracting" | "failed" | "ready",
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    await this.prisma.sourceDocument
      .update({
        where: { id },
        data: {
          extractionStatus: status as ExtractionStatus,
          ...(errorCode ? { extractionErrorCode: errorCode } : {}),
          ...(errorMessage ? { extractionErrorMessage: errorMessage } : {}),
        },
      })
      .catch(() => undefined);
  }

  /** F1 failure contract — course failed + documents stamped, no retry. */
  private async failCourse(courseId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: courseId },
        data: { status: "failed", failureReason: reason },
      }),
      this.prisma.sourceDocument.updateMany({
        where: { courseId, extractionStatus: { not: "ready" } },
        data: { extractionStatus: "failed" },
      }),
      this.prisma.ingestionRun.updateMany({
        where: { courseId, status: "running" },
        data: {
          status: "failed",
          stage: "failed" as IngestionStage,
          errorMessage: reason,
          completedAt: new Date(),
        },
      }),
    ]);
  }

  // ── verification + loading ───────────────────────────────────────────

  /** Throws when the uploaded file is missing, empty, or unrecognizable. */
  private async loadVerified(document: DocumentRecord): Promise<Buffer> {
    const storageKey = document.fileUrl!;
    let raw: Buffer;
    try {
      raw = await this.storage.getObjectBytes(storageKey);
    } catch {
      throw new ExtractionError(
        IngestionErrorCode.FileCorrupted,
        `Uploaded file is missing or unreadable (document ${document.id})`,
        false,
      );
    }
    const actualKind = sniffFileKind(raw.subarray(0, 8192));
    if (raw.length === 0 || actualKind === null) {
      throw new ExtractionError(
        IngestionErrorCode.FileCorrupted,
        `Uploaded file is corrupted or unreadable (document ${document.id})`,
        false,
      );
    }
    // §5/§6 defensive pre-parse guard (belt-and-suspenders with the HTTP
    // path, since presigned bytes land out-of-band and could be replaced):
    // oversize or a DOCX archive bomb fails the document terminally —
    // validateBytes throws a non-retryable ExtractionError, which the
    // caller routes to failDocument.
    this.uploads.validateBytes(actualKind, raw);
    return raw;
  }

  /** Maps any throw onto the error taxonomy with a retryability call. */
  private classifyDocumentError(error: unknown, documentId: string): ExtractionError {
    if (error instanceof ExtractionError) return error;
    return new ExtractionError(
      IngestionErrorCode.ParserFailed,
      `Extraction failed for document ${documentId}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      true, // unclassified ⇒ assume transient so BullMQ retries it
    );
  }

  // ── retry-safe wiping ────────────────────────────────────────────────

  /**
   * Clears a document's previous extraction output before a fresh run
   * appends again — chunks, asset rows, and asset files. Scoped to the
   * document so earlier documents of the same course stay intact.
   */
  private async wipeDocumentOutput(
    courseId: string,
    documentId: string,
  ): Promise<void> {
    await withChunkScope(this.prisma, courseId, (tx) =>
      tx.sourceChunk.deleteMany({ where: { sourceDocumentId: documentId } }),
    );
    const assets = await this.prisma.sourceAsset.findMany({
      where: { sourceDocumentId: documentId },
      select: { storageKey: true },
    });
    for (const asset of assets) {
      await this.storage.deleteKey(asset.storageKey).catch(() => undefined);
    }
    await this.prisma.sourceAsset.deleteMany({
      where: { sourceDocumentId: documentId },
    });
  }

  // ── figure persistence (Phase C + doc §9 SourceAsset rows) ───────────

  /**
   * OCR pages already spent on this document, read from persisted chunk
   * metadata — the MAX_OCR_PAGES budget must survive batch boundaries and
   * run resumes, not restart at zero each window.
   */
  private async ocrPagesSoFar(documentId: string): Promise<number> {
    const chunks = await this.prisma.sourceChunk.findMany({
      where: { sourceDocumentId: documentId },
      select: { metadata: true },
    });
    return chunks.filter(
      (chunk) =>
        (chunk.metadata as { ocr?: boolean } | null)?.ocr === true,
    ).length;
  }

  /**
   * Saves a batch's figures via StorageService and returns their keys with
   * attribution info, persisting a SourceAsset row per stored file. A
   * figure that fails to save is skipped with a warning — the text of the
   * document is never lost over an image. Names are page-scoped so
   * resumed batches never overwrite earlier batches' figures.
   */
  private async persistImages(
    courseId: string,
    document: DocumentRecord,
    run: RunRecord,
    images: ExtractedImage[],
  ): Promise<{ path: string; pageRef: number; sectionIndex: number | null }[]> {
    const saved: {
      path: string;
      pageRef: number;
      sectionIndex: number | null;
    }[] = [];
    const docPrefix = document.id.slice(0, 8);

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const ext = image.format === "jpeg" ? "jpg" : "png";
      const name = `${docPrefix}-p${image.pageRef}-${i}.${ext}`;
      try {
        const key = await this.storage.putAsset(courseId, name, image.data);
        await this.prisma.sourceAsset
          .upsert({
            where: { id: `${run.id}-${docPrefix}-p${image.pageRef}-${i}` },
            create: {
              id: `${run.id}-${docPrefix}-p${image.pageRef}-${i}`,
              courseId,
              sourceDocumentId: document.id,
              storageKey: key,
              mimeType: image.format === "jpeg" ? "image/jpeg" : "image/png",
              width: image.width,
              height: image.height,
              pageNumber: image.pageRef || null,
              kind: "image",
            },
            update: { storageKey: key },
          })
          .catch(() => undefined); // asset rows are best-effort bookkeeping
        saved.push({
          path: key,
          pageRef: image.pageRef,
          sectionIndex: image.sectionIndex,
        });
      } catch (error) {
        this.logger.warn(
          `figure ${name} for document ${document.id} could not be saved: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return saved;
  }

  // ── chunk persistence (doc §22 identity fields) ──────────────────────

  /**
   * Appends a batch's chunks with document-scoped ordinals. The ordinal
   * base is DB-derived, so re-running an interrupted batch (crash after
   * insert, before checkpoint) continues cleanly rather than colliding.
   */
  private async appendChunks(
    courseId: string,
    documentId: string,
    drafts: ChunkDraft[],
  ): Promise<void> {
    const base = await this.prisma.sourceChunk.aggregate({
      where: { sourceDocumentId: documentId },
      _max: { chunkOrdinal: true },
    });
    let nextOrdinal = (base._max.chunkOrdinal ?? -1) + 1;

    const rows = drafts.map((draft) => ({
      courseId,
      sourceDocumentId: documentId,
      chunkText: draft.chunkText,
      metadata: draft.metadata as object,
      needsResearchFill: draft.needsResearchFill,
      chunkOrdinal: nextOrdinal++,
      contentHash: createHash("sha256").update(draft.chunkText).digest("hex"),
      pipelineVersion: INGESTION_PIPELINE_VERSION,
    }));

    await withChunkScope(this.prisma, courseId, async (tx) => {
      for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
        await tx.sourceChunk.createMany({
          data: rows.slice(i, i + CHUNK_INSERT_BATCH),
        });
      }
    });
  }
}
