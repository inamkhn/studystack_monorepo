import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// F8 mastery math — deterministic constants, documented once here.
// Score is a 0..1 float. Correct answers raise it, incorrect lower it,
// and exponential decay (forgetting curve) erodes it over days since
// lastReviewedAt.
const SCORE_GAIN = 0.1;
const SCORE_PENALTY = 0.15;
const SCORE_FLOOR = 0.05;
const SCORE_CEILING = 1.0;
const DECAY_PER_DAY = 0.1;
const BASE_INTERVAL_DAYS = 1;
const MS_PER_DAY = 86_400_000;

function clampScore(value: number): number {
  return Math.min(SCORE_CEILING, Math.max(SCORE_FLOOR, value));
}

/**
 * Review interval grows with mastery: a score of 0.1 → ~2 days out,
 * 0.9 → ~10 days out. Exam-prep cramming (shrinking intervals as
 * `courses.exam_date` approaches) is the F8 scheduler job's concern,
 * not this service's — it doesn't know which course a concept belongs to.
 */
function scheduleNextReview(score: number, from: Date): Date {
  const intervalDays = BASE_INTERVAL_DAYS + Math.round(score * 10);
  return new Date(from.getTime() + intervalDays * MS_PER_DAY);
}

@Injectable()
export class MasteryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * F7 submit hook: one graded quiz answer updates the student's mastery
   * for that concept. Correct raises the decayed score, incorrect lowers it.
   * Per concept, never per module — a concept tested across modules
   * aggregates into one row (F8 edge case).
   */
  async recordQuizResult(
    studentId: string,
    conceptId: string,
    correct: boolean,
  ): Promise<void> {
    const now = new Date();
    const existing = await this.prisma.masteryScore.findUnique({
      where: { studentId_conceptId: { studentId, conceptId } },
    });

    if (!existing) {
      // First contact: a correct first answer lands mid-range, an incorrect
      // one starts below the midpoint — neither starts at the ceiling.
      const initial = correct ? 0.6 : 0.3;
      await this.prisma.masteryScore.create({
        data: {
          studentId,
          conceptId,
          score: initial,
          lastReviewedAt: now,
          nextReviewAt: scheduleNextReview(initial, now),
        },
      });
      return;
    }

    const daysElapsed = Math.max(0, (now.getTime() - existing.lastReviewedAt.getTime()) / MS_PER_DAY);
    const decayed = existing.score * Math.exp(-DECAY_PER_DAY * daysElapsed);
    const updated = clampScore(decayed + (correct ? SCORE_GAIN : -SCORE_PENALTY));

    await this.prisma.masteryScore.update({
      where: { studentId_conceptId: { studentId, conceptId } },
      data: {
        score: updated,
        lastReviewedAt: now,
        nextReviewAt: scheduleNextReview(updated, now),
      },
    });
  }

  /** Current (undecayed) score for a concept, or null if never attempted. */
  async getScore(studentId: string, conceptId: string): Promise<number | null> {
    const row = await this.prisma.masteryScore.findUnique({
      where: { studentId_conceptId: { studentId, conceptId } },
      select: { score: true },
    });
    return row?.score ?? null;
  }

  /** Due-for-review concepts at a given time — consumed by the F8 scheduler job. */
  async listDue(studentId: string, at: Date = new Date()): Promise<{ conceptId: string; score: number }[]> {
    const rows = await this.prisma.masteryScore.findMany({
      where: { studentId, nextReviewAt: { lte: at } },
      select: { conceptId: true, score: true },
    });
    return rows;
  }
}
