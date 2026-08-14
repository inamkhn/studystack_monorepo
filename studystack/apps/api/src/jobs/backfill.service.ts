import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { withChunkScope } from "../common/utils/chunk-scope.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { JOB_PRIORITY, RESEARCH_QUEUE } from "./jobs.constants.js";

export interface BackfillJobData {
  courseId: string;
  subtopicId: string;
  /** Heading of the flagged section from the upload. */
  heading: string;
  /** The thin chunk text as anchor context for generation. */
  anchorText: string;
}

/** Minimum normalized length for containment matches — avoids "Intro" etc. */
const MIN_MATCH_CHARS = 6;

/** Normalizes for fuzzy heading ↔ subtopic comparison. */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves a flagged section heading to the course-structure subtopic it
 * belongs under. Exact normalized match wins; otherwise bidirectional
 * containment (both directions — LLM titles paraphrase, headings can be
 * longer than subtopic titles or vice versa).
 *
 * Pure function so it can be smoke-tested without a DB.
 */
export function matchSubtopicForHeading(
  heading: string,
  subtopics: { id: string; title: string }[],
): { id: string; title: string } | null {
  const normalizedHeading = normalizeTitle(heading);
  if (!normalizedHeading) return null;

  for (const subtopic of subtopics) {
    if (normalizeTitle(subtopic.title) === normalizedHeading) return subtopic;
  }
  for (const subtopic of subtopics) {
    const normalizedTitle = normalizeTitle(subtopic.title);
    if (normalizedTitle.length < MIN_MATCH_CHARS) continue;
    if (
      normalizedHeading.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedHeading)
    ) {
      return subtopic;
    }
  }
  return null;
}

/**
 * F1 Phase C — needs_research_fill backfill producer.
 *
 * Fired after F4 structuring flips a course to `ready`: every flagged
 * chunk is matched to a structure subtopic and enqueued on the research
 * queue at priority 2 (below fresh ingestion, per the F1 spec's priority
 * tiering — a burst of uploads must never starve behind backfill work).
 * Unmatched flags are skipped with a log: they have no structure anchor
 * to hang generated content on.
 */
@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(RESEARCH_QUEUE) private readonly researchQueue: Queue,
  ) {}

  /** Returns the number of backfill jobs enqueued. */
  async enqueueCourseBackfill(courseId: string): Promise<number> {
    const [flagged, subtopics] = await Promise.all([
      // RLS scope: source_chunks access runs under app.current_course_id.
      withChunkScope(this.prisma, courseId, (tx) =>
        tx.sourceChunk.findMany({
          where: { courseId, needsResearchFill: true },
          select: { chunkText: true, metadata: true },
          orderBy: { createdAt: "asc" },
        }),
      ),
      this.prisma.subtopic.findMany({
        where: { module: { courseId } },
        select: { id: true, title: true },
      }),
    ]);
    if (flagged.length === 0 || subtopics.length === 0) return 0;

    // One job per subtopic — several thin headings may map to the same
    // subtopic; the longest anchor wins as generation context.
    const bySubtopic = new Map<string, BackfillJobData>();

    for (const chunk of flagged) {
      const heading =
        typeof chunk.metadata === "object" &&
        chunk.metadata !== null &&
        "heading" in chunk.metadata &&
        typeof (chunk.metadata as Record<string, unknown>).heading === "string"
          ? ((chunk.metadata as Record<string, unknown>).heading as string)
          : "";
      if (!heading) continue;

      const match = matchSubtopicForHeading(heading, subtopics);
      if (!match) continue;

      const existing = bySubtopic.get(match.id);
      if (!existing || chunk.chunkText.length > existing.anchorText.length) {
        bySubtopic.set(match.id, {
          courseId,
          subtopicId: match.id,
          heading,
          anchorText: chunk.chunkText,
        });
      }
    }

    if (bySubtopic.size === 0) {
      this.logger.log(
        `course ${courseId}: ${flagged.length} flagged section(s) matched no ` +
          `structure subtopic — backfill skipped`,
      );
      return 0;
    }

    for (const data of bySubtopic.values()) {
      await this.researchQueue.add(
        "backfill-subtopic",
        data,
        {
          priority: JOB_PRIORITY.researchFillBackfill,
          jobId: `backfill:${data.subtopicId}`,
          attempts: 2,
          backoff: { type: "exponential", delay: 30_000 },
        },
      );
    }

    this.logger.log(
      `course ${courseId}: ${bySubtopic.size} research-fill backfill job(s) enqueued`,
    );
    return bySubtopic.size;
  }
}
