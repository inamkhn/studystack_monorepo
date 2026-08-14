import { Logger } from "@nestjs/common";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { readFile } from "fs/promises";
import * as path from "path";
import { readFileHead, sniffFileKind } from "../common/utils/file-validation.js";
import { detectLanguage } from "../common/utils/language-detection.js";
import { withChunkScope } from "../common/utils/chunk-scope.js";
import { resolveStoredPath } from "../common/utils/storage.js";
import {
  buildChunks,
  createCourseAssetSaver,
  extractDocxSections,
  extractPdfSections,
  extractTextSections,
  type ChunkDraft,
  type ExtractionResult,
} from "../ai/pipeline/index.js";
import { embedCourseChunks } from "../ai/pipeline/embedder.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { INGESTION_QUEUE, JOB_PRIORITY, STRUCTURING_QUEUE } from "./jobs.constants.js";

/** Chunk rows are persisted in batches to keep memory bounded on big docs. */
const CHUNK_INSERT_BATCH = 200;

/**
 * F1 — async ingestion worker (BullMQ), Phase A+B pipeline:
 *
 *   extracting → chunking → embedding → (convergence)
 *     → intake_pending        (intake not recorded yet)
 *     → structuring job       (intake recorded; F4 structuring finishes it)
 *
 * Extraction runs the format extractors (text/Markdown, DOCX via mammoth,
 * PDF via unpdf with Tesseract fallback for scanned pages), figures are
 * persisted under uploads/assets/<courseId>/ and linked to their source
 * section via chunk metadata, chunks are persisted to `source_chunks`
 * with `needsResearchFill` flags, then every chunk is embedded via the
 * AI Gateway (768-dim pgvector writes).
 *
 * The F1 failure contract is preserved end-to-end: corrupted/vanished files
 * and zero-content extractions mark the course `failed` with a reason.
 */
@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(STRUCTURING_QUEUE) private readonly structuringQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ courseId: string }>): Promise<void> {
    const { courseId } = job.data;

    await this.setStage(courseId, "extracting");

    try {
      // ── Stage 1: verify + extract every uploaded document ────────────
      const documents = await this.prisma.sourceDocument.findMany({
        where: { courseId, fileUrl: { not: null } },
      });

      const allDrafts: (ChunkDraft & { sourceDocumentId: string })[] = [];
      let extractedAny = false;
      let ocrPagesTotal = 0;
      let imagesTotal = 0;

      // Phase C — figures are stored per course and wiped on re-run so a
      // retried ingestion never leaves stale or duplicate assets.
      const assets = createCourseAssetSaver(courseId);
      await assets.wipe();

      for (let docIndex = 0; docIndex < documents.length; docIndex++) {
        const document = documents[docIndex];
        // fileUrl is a storage key relative to UPLOAD_DIR (legacy absolute
        // paths still resolve — see common/utils/storage.ts).
        const filePath = resolveStoredPath(document.fileUrl!);
        await this.verifyDocument(document.id, filePath);
        await this.setDocumentStatus(document.id, "extracting");

        let result: ExtractionResult;
        try {
          result = await this.extractDocument(filePath);
        } catch (error) {
          // One unreadable document must not sink the whole course when
          // other documents extract fine — mark it failed and continue.
          await this.setDocumentStatus(document.id, "failed");
          this.logger.warn(
            `extraction failed for document ${document.id}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          continue;
        }

        if (result.sections.length === 0) {
          await this.setDocumentStatus(document.id, "failed");
          continue;
        }

        const drafts = buildChunks(result.sections);

        // Persist figures + link them back to the drafts of their section
        // (by section index when the extractor attributed one, else by
        // page for PDFs). Failures are per-image, never per-document.
        const saved = await this.persistDocumentImages(
          assets,
          document.id,
          result,
        );
        imagesTotal += saved.length;
        if (saved.length > 0) {
          for (const draft of drafts) {
            const linked = saved.filter((image) =>
              image.sectionIndex !== null
                ? image.sectionIndex === draft.metadata.sectionIndex
                : image.pageRef !== 0 &&
                  image.pageRef === draft.metadata.pageRef,
            );
            if (linked.length > 0) {
              draft.metadata.images = linked.map((image) => image.path);
            }
          }
        }

        allDrafts.push(
          ...drafts.map((draft) => ({ ...draft, sourceDocumentId: document.id })),
        );
        extractedAny = true;
        ocrPagesTotal += result.ocrPages;
        await this.setDocumentStatus(document.id, "done");
        await job.updateProgress({
          stage: "extracting",
          documentsDone: docIndex + 1,
          documentsTotal: documents.length,
        });
      }

      if (!extractedAny || allDrafts.length === 0) {
        await this.failCourse(
          courseId,
          "No readable content could be extracted from the uploaded file(s)",
        );
        return;
      }

      // ── F1 §2.3: language from extracted text (covers PDF/DOCX, which
      // the upload path couldn't read). Only fills when still unknown. ───
      await this.detectCourseLanguage(courseId, allDrafts);

      // ── Stage 2: persist chunks (retry-safe: wipe stale rows first) ───
      await this.setStage(courseId, "chunking");
      await this.persistChunks(courseId, allDrafts);

      // ── Stage 3: embeddings (Phase B). Idempotent — only rows without
      // a vector are embedded. Recoverable, not fatal: without a Gateway
      // key (or during a provider outage) chunks stay unembedded and the
      // course still converges; the gap can be filled later by a re-run.
      // Extraction failures stay fatal per the F1 failure contract. ───────
      await this.setStage(courseId, "embedding");
      let embeddedCount = 0;
      try {
        embeddedCount = await embedCourseChunks(this.prisma, courseId);
      } catch (error) {
        this.logger.warn(
          `embedding stage skipped for course ${courseId} (recoverable): ${
            error instanceof Error ? error.message : error
          }`,
        );
      }

      // ── Stage 4: convergence (F3). Intake recorded → F4 structuring
      // job; otherwise park at intake_pending until goal+level arrive. ───
      const course = await this.prisma.course.findUnique({
        where: { id: courseId },
        select: { goal: true, level: true },
      });
      const intakeRecorded = Boolean(course?.goal && course?.level);

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

      this.logger.log(
        `ingestion complete for course ${courseId}: ${allDrafts.length} chunks ` +
          `(${allDrafts.filter((d) => d.needsResearchFill).length} flagged ` +
          `needs_research_fill, ${embeddedCount} embedded, ` +
          `${ocrPagesTotal} pages OCR'd, ${imagesTotal} figures kept) → ` +
          (intakeRecorded ? "structuring" : "intake_pending"),
      );
    } catch (error) {
      // Extraction-level failure (corruption etc.) — fail the course, no
      // retry. Mirrors CourseService.failCourseIngestion (not imported to
      // avoid a JobsModule ↔ CourseModule cycle).
      const reason =
        error instanceof Error ? error.message : "Source file unreadable";
      this.logger.error(`ingestion failed for course ${courseId}: ${reason}`);
      await this.failCourse(courseId, reason);
    }
  }

  // ── stage helpers ─────────────────────────────────────────────────────

  private async setStage(courseId: string, stage: string): Promise<void> {
    await this.prisma.course
      .update({ where: { id: courseId }, data: { ingestionStage: stage } })
      .catch(() => undefined); // course may have been deleted meanwhile
  }

  private async setDocumentStatus(id: string, status: string): Promise<void> {
    await this.prisma.sourceDocument
      .update({ where: { id }, data: { extractionStatus: status } })
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
        where: { courseId },
        data: { extractionStatus: "failed" },
      }),
    ]);
  }

  // ── extraction ────────────────────────────────────────────────────────

  /** Throws when the uploaded file is missing, empty, or unrecognizable. */
  private async verifyDocument(documentId: string, filePath: string) {
    let head: Buffer;
    try {
      head = await readFileHead(filePath, 8192);
    } catch {
      throw new Error(
        `Uploaded file is missing or unreadable (document ${documentId})`,
      );
    }
    if (head.length === 0 || sniffFileKind(head) === null) {
      throw new Error(
        `Uploaded file is corrupted or unreadable (document ${documentId})`,
      );
    }
  }

  private async extractDocument(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const kind = path.extname(filePath).toLowerCase();

    switch (kind) {
      case ".pdf":
        return extractPdfSections(buffer);
      case ".docx":
        return extractDocxSections(buffer);
      case ".txt":
      case ".md":
      default:
        return extractTextSections(buffer.toString("utf8"));
    }
  }

  // ── figure persistence (Phase C) ─────────────────────────────────────

  /**
   * Saves a document's extracted figures to disk and returns their paths
   * with attribution info. A figure that fails to save is skipped with a
   * warning — the text of the document is never lost over an image.
   */
  private async persistDocumentImages(
    assets: ReturnType<typeof createCourseAssetSaver>,
    documentId: string,
    result: ExtractionResult,
  ): Promise<{
    path: string;
    pageRef: number;
    sectionIndex: number | null;
  }[]> {
    const saved: {
      path: string;
      pageRef: number;
      sectionIndex: number | null;
    }[] = [];

    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const ext = image.format === "jpeg" ? "jpg" : "png";
      const name = `${documentId.slice(0, 8)}-${i}.${ext}`;
      try {
        const filePath = await assets.save(name, image.data);
        saved.push({
          path: filePath,
          pageRef: image.pageRef,
          sectionIndex: image.sectionIndex,
        });
      } catch (error) {
        this.logger.warn(
          `figure ${name} for document ${documentId} could not be saved: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    return saved;
  }

  // ── language detection (F1 §2.3) ──────────────────────────────────────

  private async detectCourseLanguage(
    courseId: string,
    drafts: ChunkDraft[],
  ): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { language: true },
    });
    if (course?.language) return; // already detected at upload (text files)

    const sample = drafts
      .filter((d) => !d.metadata.ocr) // OCR text is noisy — prefer digital
      .map((d) => d.chunkText)
      .join("\n")
      .slice(0, 65536);

    const language = detectLanguage(sample);
    if (language) {
      await this.prisma.course
        .update({ where: { id: courseId }, data: { language } })
        .catch(() => undefined);
    }
  }

  // ── chunk persistence ─────────────────────────────────────────────────

  private async persistChunks(
    courseId: string,
    drafts: (ChunkDraft & { sourceDocumentId: string })[],
  ): Promise<void> {
    // Retry safety: a re-run of this job must not duplicate chunks. Both
    // the wipe and the inserts run under the RLS course scope.
    await withChunkScope(this.prisma, courseId, async (tx) => {
      await tx.sourceChunk.deleteMany({ where: { courseId } });

      for (let i = 0; i < drafts.length; i += CHUNK_INSERT_BATCH) {
        const batch = drafts.slice(i, i + CHUNK_INSERT_BATCH);
        await tx.sourceChunk.createMany({
          data: batch.map((draft) => ({
            sourceDocumentId: draft.sourceDocumentId,
            courseId,
            chunkText: draft.chunkText,
            metadata: draft.metadata,
            needsResearchFill: draft.needsResearchFill,
          })),
        });
      }
    });
  }
}
