import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Admin-only service for the concept dedup review queue (F4 expanded).
 * Separated from {@link ConceptService} because the merge transaction is a
 * self-contained admin workflow with no student-facing callers.
 */
@Injectable()
export class ConceptReviewService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Review queue ────────────────────────────────────────────────────────

  async listReviewCandidates() {
    return this.prisma.conceptReviewCandidate.findMany({
      where: { status: "pending_review" },
      include: { candidateConcept: true, matchedConcept: true },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Confirms a duplicate pair and runs mergeConcepts(): every reference to the
   * candidate (duplicate) concept is moved onto the matched (surviving) one.
   */
  async mergeCandidate(candidateId: string, adminId: string) {
    const candidate = await this.prisma.conceptReviewCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new NotFoundException("Review candidate not found");
    }

    if (candidate.status !== "pending_review") {
      throw new BadRequestException("Candidate already resolved");
    }

    if (candidate.candidateConceptId === candidate.matchedConceptId) {
      throw new BadRequestException(
        "Candidate and match are the same concept — nothing to merge",
      );
    }

    const survivingId = candidate.matchedConceptId;
    const duplicateId = candidate.candidateConceptId;

    await this.prisma.$transaction(async (tx) => {
      // 1. subtopic_concepts — reassign; rows that would collide with the
      //    survivor's own link are dropped (the subtopic already knows the
      //    concept under its canonical id).
      const duplicateLinks = await tx.subtopicConcept.findMany({
        where: { conceptId: duplicateId },
      });

      for (const link of duplicateLinks) {
        const collision = await tx.subtopicConcept.findUnique({
          where: {
            subtopicId_conceptId: {
              subtopicId: link.subtopicId,
              conceptId: survivingId,
            },
          },
        });

        if (collision) {
          await tx.subtopicConcept.delete({
            where: {
              subtopicId_conceptId: {
                subtopicId: link.subtopicId,
                conceptId: duplicateId,
              },
            },
          });
        } else {
          await tx.subtopicConcept.update({
            where: {
              subtopicId_conceptId: {
                subtopicId: link.subtopicId,
                conceptId: duplicateId,
              },
            },
            data: { conceptId: survivingId },
          });
        }
      }

      // 2. quiz_attempts — plain FK, reassign directly.
      await tx.quizAttempt.updateMany({
        where: { conceptId: duplicateId },
        data: { conceptId: survivingId },
      });

      // 3. mastery_scores — combine overlapping (student, concept) rows:
      //    higher score + more recent review wins; non-overlapping rows move.
      const duplicateScores = await tx.masteryScore.findMany({
        where: { conceptId: duplicateId },
      });

      for (const score of duplicateScores) {
        const survivingScore = await tx.masteryScore.findUnique({
          where: {
            studentId_conceptId: {
              studentId: score.studentId,
              conceptId: survivingId,
            },
          },
        });

        if (survivingScore) {
          const survivingIsMoreRecent =
            survivingScore.lastReviewedAt >= score.lastReviewedAt;

          await tx.masteryScore.update({
            where: {
              studentId_conceptId: {
                studentId: score.studentId,
                conceptId: survivingId,
              },
            },
            data: {
              score: Math.max(survivingScore.score, score.score),
              lastReviewedAt: survivingIsMoreRecent
                ? survivingScore.lastReviewedAt
                : score.lastReviewedAt,
              nextReviewAt: survivingIsMoreRecent
                ? survivingScore.nextReviewAt
                : score.nextReviewAt,
            },
          });

          await tx.masteryScore.delete({
            where: {
              studentId_conceptId: {
                studentId: score.studentId,
                conceptId: duplicateId,
              },
            },
          });
        } else {
          await tx.masteryScore.update({
            where: {
              studentId_conceptId: {
                studentId: score.studentId,
                conceptId: duplicateId,
              },
            },
            data: { conceptId: survivingId },
          });
        }
      }

      // 4. concept_review_content — persona review explanations (F8) follow
      //    the survivor; rows colliding on (concept, level, angleVariant) are
      //    dropped in favour of the survivor's own.
      const duplicateContent = await tx.conceptReviewContent.findMany({
        where: { conceptId: duplicateId },
      });

      for (const content of duplicateContent) {
        const collision = await tx.conceptReviewContent.findUnique({
          where: {
            conceptId_level_angleVariant: {
              conceptId: survivingId,
              level: content.level,
              angleVariant: content.angleVariant,
            },
          },
        });

        if (collision) {
          await tx.conceptReviewContent.delete({ where: { id: content.id } });
        } else {
          await tx.conceptReviewContent.update({
            where: { id: content.id },
            data: { conceptId: survivingId },
          });
        }
      }

      // 5. Soft-delete the duplicate — keeps historical references valid.
      await tx.concept.update({
        where: { id: duplicateId },
        data: { mergedIntoId: survivingId, matchStatus: "resolved" },
      });

      // 6. Close the review item.
      await tx.conceptReviewCandidate.update({
        where: { id: candidateId },
        data: {
          status: "resolved_merged",
          resolvedAt: new Date(),
          resolvedByUserId: adminId,
        },
      });
    });

    return { merged: survivingId, duplicate: duplicateId };
  }

  async dismissCandidate(candidateId: string, adminId: string) {
    const candidate = await this.prisma.conceptReviewCandidate.findUnique({
      where: { id: candidateId },
    });

    if (!candidate) {
      throw new NotFoundException("Review candidate not found");
    }

    if (candidate.status !== "pending_review") {
      throw new BadRequestException("Candidate already resolved");
    }

    return this.prisma.conceptReviewCandidate.update({
      where: { id: candidateId },
      data: {
        status: "dismissed",
        resolvedAt: new Date(),
        resolvedByUserId: adminId,
      },
    });
  }
}
