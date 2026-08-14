import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import type { Level } from "../generated/prisma/client.js";
import { AiService } from "../ai/ai.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F8 — cache-first review explainer.
 *
 * Generated once per (conceptId, level, angleVariant) key and shared across
 * all students — identical to the F6 tutorial-content caching pattern.
 * `angleVariant` is server-selected via round-robin over existing variants
 * for this (conceptId, level) pair; the client never requests a specific angle.
 */
@Injectable()
export class ReviewContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Returns a re-angled review explanation for this concept at the given level.
   *
   * @param level — the student's level; defaults to "beginner" for students
   *   without an enrolled course. TODO(F8): derive from the student's active
   *   course or fork level once a user-level attribute lands.
   */
  async getReviewContent(
    conceptId: string,
    level: Level = "beginner",
  ): Promise<{ conceptId: string; level: Level; angleVariant: number; explanation: string }> {
    // ── resolve concept (handle merged-into redirect) ─────────────────
    const concept = await this.prisma.concept.findUnique({
      where: { id: conceptId },
      select: { id: true, canonicalName: true, mergedIntoId: true },
    });
    if (!concept) {
      throw new NotFoundException("Concept not found");
    }

    // Follow merge chain to the surviving concept (may be multi-hop:
    // A → B → C where A was merged into B, B later merged into C).
    let resolved = concept;
    let name = concept.canonicalName;
    while (resolved.mergedIntoId) {
      resolved = await this.prisma.concept.findUniqueOrThrow({
        where: { id: resolved.mergedIntoId },
        select: { id: true, canonicalName: true, mergedIntoId: true },
      });
      name = resolved.canonicalName;
    }
    const resolvedId = resolved.id;
    const resolvedName = name;

    // ── angle-variant rotation ──────────────────────────────────────
    const existingCount = await this.prisma.conceptReviewContent.count({
      where: { conceptId: resolvedId, level },
    });

    // Round-robin: pick the next unused variant index.
    // This means the first generation gets angleVariant=0, second gets 1, etc.
    const angleVariant = existingCount;

    // ── cache hit ────────────────────────────────────────────────────
    const cached = await this.prisma.conceptReviewContent.findUnique({
      where: {
        conceptId_level_angleVariant: {
          conceptId: resolvedId,
          level,
          angleVariant,
        },
      },
    });
    if (cached) {
      return {
        conceptId: resolvedId,
        level,
        angleVariant,
        explanation: cached.explanation,
      };
    }

    // ── cache miss → generate ───────────────────────────────────────
    const explanation = await this.ai.regenerateConceptExplanation({
      conceptId: resolvedId,
      canonicalName: resolvedName,
      level,
      angleVariant,
    });

    try {
      await this.prisma.conceptReviewContent.create({
        data: {
          conceptId: resolvedId,
          level,
          angleVariant,
          explanation,
        },
      });
    } catch (error) {
      // Concurrent cache-miss — another caller already generated and wrote
      // this variant. Serve the winner's row instead of failing.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Return the winner's explanation (ignore our generated one).
        const winner =
          await this.prisma.conceptReviewContent.findUniqueOrThrow({
            where: {
              conceptId_level_angleVariant: {
                conceptId: resolvedId,
                level,
                angleVariant,
              },
            },
          });
        return {
          conceptId: resolvedId,
          level,
          angleVariant,
          explanation: winner.explanation,
        };
      }
      throw error;
    }

    return { conceptId: resolvedId, level, angleVariant, explanation };
  }

  /**
   * Returns concepts where `next_review_at <= now` for this student,
   * enriched with concept names — consumed by `GET /students/me/due-concepts`.
   */
  async getDueConcepts(
    userId: string,
  ): Promise<{ conceptId: string; canonicalName: string; score: number }[]> {
    const now = new Date();

    const rows = await this.prisma.masteryScore.findMany({
      where: { studentId: userId, nextReviewAt: { lte: now } },
      select: {
        conceptId: true,
        score: true,
        concept: { select: { canonicalName: true } },
      },
      orderBy: { nextReviewAt: "asc" },
    });

    return rows.map((r) => ({
      conceptId: r.conceptId,
      canonicalName: r.concept.canonicalName,
      score: r.score,
    }));
  }
}
