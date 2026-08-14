import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import type { CourseStructure } from "@studystack/types";
import { embedConceptRows } from "../ai/pipeline/embedder.js";
import { generateCourseStructure } from "../ai/pipeline/structuring.js";
import { withChunkScope } from "../common/utils/chunk-scope.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { BackfillService } from "./backfill.service.js";
import { STRUCTURING_QUEUE } from "./jobs.constants.js";

/**
 * F4 — course structuring worker (Phase B).
 *
 * Runs after ingestion + intake have converged: one bounded frontier call
 * generates modules → subtopics → concepts (Zod-validated), concepts are
 * resolved by canonical-name dedup and embedded, then the course flips to
 * `ready`. Retry-safe: existing structure for the course is wiped before
 * writing, so a re-run converges to the same end state.
 */
@Processor(STRUCTURING_QUEUE)
export class StructuringProcessor extends WorkerHost {
  private readonly logger = new Logger(StructuringProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backfill: BackfillService,
  ) {
    super();
  }

  async process(job: Job<{ courseId: string }>): Promise<void> {
    const { courseId } = job.data;

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });
    if (!course || course.status === "ready") return;

    try {
      await this.setStage(courseId, "structuring");

      // RLS scope: source_chunks access runs under app.current_course_id
      // (llm-handling §3.2b) — the structure prompt must never see another
      // course's chunks, even if a WHERE clause were ever forgotten.
      const chunks = await withChunkScope(this.prisma, courseId, (tx) =>
        tx.sourceChunk.findMany({
          where: { courseId, needsResearchFill: false },
          select: { chunkText: true, metadata: true },
          orderBy: { createdAt: "asc" },
        }),
      );
      if (chunks.length === 0) {
        throw new Error("No source content available to structure");
      }

      const structure = await generateCourseStructure({
        title: course.title,
        level: course.level,
        language: course.language,
        chunks: chunks.map((chunk) => ({
          chunkText: chunk.chunkText,
          heading:
            typeof chunk.metadata === "object" &&
            chunk.metadata !== null &&
            "heading" in chunk.metadata &&
            typeof (chunk.metadata as Record<string, unknown>).heading ===
              "string"
              ? ((chunk.metadata as Record<string, unknown>).heading as string)
              : null,
        })),
      });

      await this.persistStructure(courseId, course.topic, structure);

      await this.prisma.course.update({
        where: { id: courseId },
        data: {
          status: "ready",
          ingestionStage: null,
          failureReason: null,
        },
      });

      // Phase C — enqueue priority-2 research-fill backfill for flagged
      // sections. Non-fatal: the course is ready either way, and the
      // on-demand tutorial path covers any subtopic backfill misses.
      try {
        await this.backfill.enqueueCourseBackfill(courseId);
      } catch (error) {
        this.logger.warn(
          `backfill enqueue skipped for course ${courseId} (recoverable): ${
            error instanceof Error ? error.message : error
          }`,
        );
      }

      this.logger.log(
        `course ${courseId} structured: ${structure.modules.length} modules, ` +
          `${structure.modules.reduce((n, m) => n + m.subtopics.length, 0)} subtopics → ready`,
      );
    } catch (error) {
      // Let BullMQ retry transient failures until attempts are exhausted;
      // only then apply the F1 failure contract.
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts - 1) {
        this.logger.warn(
          `structuring attempt ${job.attemptsMade + 1}/${attempts} failed for ` +
            `course ${courseId}: ${error instanceof Error ? error.message : error}`,
        );
        throw error;
      }

      const reason =
        error instanceof Error
          ? `Structuring failed: ${error.message}`
          : "Structuring failed";
      this.logger.error(`structuring failed for course ${courseId}: ${reason}`);
      await this.prisma.course.update({
        where: { id: courseId },
        data: { status: "failed", failureReason: reason },
      });
    }
  }

  private async setStage(courseId: string, stage: string): Promise<void> {
    await this.prisma.course
      .update({ where: { id: courseId }, data: { ingestionStage: stage } })
      .catch(() => undefined);
  }

  /**
   * Writes modules/subtopics/concepts/links for the course.
   * Concept resolution (Phase B): case-insensitive canonical-name match
   * reuses existing global concepts; new ones are created and embedded.
   * Embedding-similarity resolution with review candidates is the F4
   * follow-up once retrieval exists.
   */
  private async persistStructure(
    courseId: string,
    existingTopic: string | null,
    structure: CourseStructure,
  ): Promise<void> {
    // Retry safety — wipe this course's previous structure.
    await this.prisma.subtopicConcept.deleteMany({
      where: { subtopic: { module: { courseId } } },
    });
    await this.prisma.subtopic.deleteMany({
      where: { module: { courseId } },
    });
    await this.prisma.module.deleteMany({ where: { courseId } });

    // Resolve every distinct concept name once.
    const uniqueConcepts = new Map<
      string,
      { canonicalName: string; aliases: string[] }
    >();
    for (const module of structure.modules) {
      for (const subtopic of module.subtopics) {
        for (const concept of subtopic.concepts) {
          const key = concept.canonicalName.trim().toLowerCase();
          if (!uniqueConcepts.has(key)) {
            uniqueConcepts.set(key, {
              canonicalName: concept.canonicalName.trim(),
              aliases: concept.aliases,
            });
          }
        }
      }
    }

    const nameToConceptId = new Map<string, string>();
    const newConceptRows: { id: string; text: string }[] = [];

    for (const [key, concept] of uniqueConcepts) {
      const existing = await this.prisma.concept.findFirst({
        where: { canonicalName: { equals: concept.canonicalName, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) {
        nameToConceptId.set(key, existing.id);
        continue;
      }
      const created = await this.prisma.concept.create({
        data: {
          canonicalName: concept.canonicalName,
          subjectArea: structure.subjectArea,
          aliases: concept.aliases,
          matchStatus: "confident",
        },
      });
      nameToConceptId.set(key, created.id);
      newConceptRows.push({
        id: created.id,
        text: concept.aliases.length
          ? `${concept.canonicalName} (${concept.aliases.join(", ")})`
          : concept.canonicalName,
      });
    }

    // Embed new concepts in one batched call.
    await embedConceptRows(this.prisma, newConceptRows);

    // Write modules → subtopics → concept links, preserving order.
    for (let moduleOrder = 0; moduleOrder < structure.modules.length; moduleOrder++) {
      const moduleSpec = structure.modules[moduleOrder];
      const module = await this.prisma.module.create({
        data: {
          courseId,
          order: moduleOrder,
          title: moduleSpec.title,
        },
      });

      for (
        let subtopicOrder = 0;
        subtopicOrder < moduleSpec.subtopics.length;
        subtopicOrder++
      ) {
        const subtopicSpec = moduleSpec.subtopics[subtopicOrder];
        const subtopic = await this.prisma.subtopic.create({
          data: {
            moduleId: module.id,
            order: subtopicOrder,
            title: subtopicSpec.title,
            calcHeavy: subtopicSpec.calcHeavy,
          },
        });

        const conceptIds = [
          ...new Set(
            subtopicSpec.concepts.map(
              (c) => nameToConceptId.get(c.canonicalName.trim().toLowerCase())!,
            ),
          ),
        ];
        if (conceptIds.length) {
          await this.prisma.subtopicConcept.createMany({
            data: conceptIds.map((conceptId) => ({
              subtopicId: subtopic.id,
              conceptId,
            })),
            skipDuplicates: true,
          });
        }
      }
    }

    // Uploads carry no topic — the derived subject area fills the browse
    // filter field without touching topic courses.
    if (!existingTopic) {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { topic: structure.subjectArea },
      });
    }
  }
}
