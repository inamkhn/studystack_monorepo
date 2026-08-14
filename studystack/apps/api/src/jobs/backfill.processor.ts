import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import type { Level } from "../generated/prisma/client.js";
import { generateResearchFill } from "../ai/pipeline/backfill.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RESEARCH_QUEUE } from "./jobs.constants.js";
import type { BackfillJobData } from "./backfill.service.js";

/**
 * F1 Phase C — research-fill backfill worker, sharing the research queue
 * with the (future) F2 topic-research job. Jobs are dispatched by name:
 *
 * - `backfill-subtopic` (this phase): generates teaching content for a
 *   needs_research_fill section under its matched structure subtopic and
 *   caches it in tutorial_content (the F6 cache key), provenance
 *   `generated`.
 * - `research-course`: F2 topic-only research — still a stub until the
 *   full generation pipeline lands.
 *
 * Backfill failure must never un-ready a course: after retries exhaust
 * the job is dropped with an error log — Feature 6's on-demand tutorial
 * generation remains the fallback for that subtopic.
 */
@Processor(RESEARCH_QUEUE)
export class BackfillProcessor extends WorkerHost {
  private readonly logger = new Logger(BackfillProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === "backfill-subtopic") {
      return this.processBackfill(job as Job<BackfillJobData>);
    }
    if (job.name === "research-course") {
      // F2 stub — real topic research lands with the generation pipeline.
      this.logger.warn(
        `[stub] research for course ${
          (job.data as { courseId?: string }).courseId
        } — research pipeline not yet implemented (AiModule step)`,
      );
      return;
    }
    this.logger.warn(`unknown research-queue job "${job.name}" — ignored`);
  }

  private async processBackfill(job: Job<BackfillJobData>): Promise<void> {
    const { courseId, subtopicId, heading, anchorText } = job.data;

    try {
      const [course, subtopic] = await Promise.all([
        this.prisma.course.findUnique({ where: { id: courseId } }),
        this.prisma.subtopic.findUnique({ where: { id: subtopicId } }),
      ]);
      // Course deleted/failed or structure wiped meanwhile — nothing to fill.
      if (!course || !subtopic || course.status !== "ready") return;

      const level: Level = course.level ?? "beginner";

      // Idempotent — F6 cache key is (subtopic, level, styleBucket). A
      // completed backfill or an on-demand generation both short-circuit.
      const existing = await this.prisma.tutorialContent.findUnique({
        where: {
          subtopicId_level_styleBucket: {
            subtopicId,
            level,
            styleBucket: "neutral",
          },
        },
        select: { id: true },
      });
      if (existing) return;

      const explanation = await generateResearchFill({
        courseTitle: course.title,
        subtopicTitle: subtopic.title,
        heading,
        anchorText,
        language: course.language,
        level: course.level,
      });

      await this.prisma.tutorialContent.create({
        data: {
          subtopicId,
          level,
          styleBucket: "neutral",
          explanation: {
            format: "markdown",
            text: explanation,
            generatedBy: "research_fill_backfill",
          },
          provenance: "generated",
        },
      });

      this.logger.log(
        `research-fill backfilled subtopic ${subtopicId} ("${subtopic.title}") ` +
          `for course ${courseId}`,
      );
    } catch (error) {
      // Retry transient Gateway failures; after attempts exhaust, drop the
      // job — the on-demand tutorial path still covers this subtopic.
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts - 1) {
        this.logger.warn(
          `backfill attempt ${job.attemptsMade + 1}/${attempts} failed for ` +
            `subtopic ${subtopicId}: ${
              error instanceof Error ? error.message : error
            }`,
        );
        throw error;
      }
      this.logger.error(
        `research-fill backfill failed for subtopic ${subtopicId} ` +
          `(course ${courseId}): ${
            error instanceof Error ? error.message : error
          } — on-demand generation remains the fallback`,
      );
    }
  }
}
