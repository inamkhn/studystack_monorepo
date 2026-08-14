import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Level } from "../generated/prisma/client.js";
import { AiService } from "../ai/ai.service.js";
import { MasteryService } from "../mastery/mastery.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F12 — Step-by-Step Practice Problems.
 *
 * Generated once per subtopic on first request, gated on the
 * calc/application-heavy flag. Attempts are recorded in `quiz_attempts`
 * (type = `practice_problem`) and optionally feed mastery updates.
 */
@Injectable()
export class PracticeProblemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly mastery: MasteryService,
  ) {}

  /**
   * Returns this subtopic's practice problems, generating on first
   * request if not already produced.
   *
   * Gated on `subtopics.practice_problems_override` (takes precedence
   * when non-null) or the auto-generated `calcHeavy` flag. Returns an
   * empty set for subtopics that don't qualify — never a 404.
   */
  async getProblems(
    subtopicId: string,
  ): Promise<{
    problems: { id: string; problemText: string; hintsJson: unknown; solution: string }[];
    gated: boolean;
  }> {
    // Validate subtopic, pull gate flags + concepts in one query.
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      select: {
        id: true,
        title: true,
        calcHeavy: true,
        practiceProblemsOverride: true,
        module: { select: { course: { select: { level: true } } } },
        subtopicConcepts: {
          select: { concept: { select: { id: true, canonicalName: true } } },
        },
      },
    });
    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    // ── calc gate ─────────────────────────────────────────────────────
    const qualifies =
      subtopic.practiceProblemsOverride ?? subtopic.calcHeavy;
    if (!qualifies) {
      return { problems: [], gated: false };
    }

    // ── cache hit ─────────────────────────────────────────────────────
    const existing = await this.prisma.practiceProblem.findMany({
      where: { subtopicId },
      select: { id: true, problemText: true, hintsJson: true, solution: true },
      orderBy: { id: "asc" },
    });
    if (existing.length > 0) {
      return { problems: existing, gated: true };
    }

    // ── cache miss → generate ─────────────────────────────────────────
    const concepts = subtopic.subtopicConcepts.map((sc) => ({
      conceptId: sc.concept.id,
      canonicalName: sc.concept.canonicalName,
    }));

    const level: Level = subtopic.module.course.level ?? "beginner";

    const generated = await this.ai.generatePracticeProblems({
      subtopicId,
      subtopicTitle: subtopic.title,
      level,
      concepts,
    });

    // Write inside a transaction with a post-generation re-check —
    // two concurrent cache misses on the same subtopic will race to
    // generate, but only one writes; the loser returns the winner's rows.
    const rows = await this.prisma.$transaction(async (tx) => {
      const recheck = await tx.practiceProblem.findMany({
        where: { subtopicId },
        select: { id: true, problemText: true, hintsJson: true, solution: true },
        orderBy: { id: "asc" },
      });
      if (recheck.length > 0) {
        return recheck;
      }

      for (const p of generated) {
        await tx.practiceProblem.create({
          data: {
            subtopicId,
            problemText: p.problemText,
            hintsJson: p.hintsJson as object,
            solution: p.solution,
          },
        });
      }

      return tx.practiceProblem.findMany({
        where: { subtopicId },
        select: { id: true, problemText: true, hintsJson: true, solution: true },
        orderBy: { id: "asc" },
      });
    });

    return { problems: rows, gated: true };
  }

  /**
   * Sets or clears `subtopics.practice_problems_override`.
   *
   * In classroom mode, a teacher's override takes precedence over the
   * student's own (Feature 19) — this endpoint doesn't resolve that
   * precedence itself; it just records whichever caller made the call.
   */
  async setOverride(
    subtopicId: string,
    override: boolean | null,
  ): Promise<{ practiceProblemsOverride: boolean | null }> {
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      select: { id: true },
    });
    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    const updated = await this.prisma.subtopic.update({
      where: { id: subtopicId },
      data: { practiceProblemsOverride: override },
      select: { practiceProblemsOverride: true },
    });

    return { practiceProblemsOverride: updated.practiceProblemsOverride };
  }

  /**
   * Records an attempt at a single practice problem and optionally feeds
   * the mastery engine.
   *
   * Attempts are stored in `quiz_attempts` with `type = practice_problem`
   * — consistent with how F9 reused the same table for final projects.
   * Mastery feed is scoped to the subtopic's first concept (practice
   * problems aren't individually concept-tagged in v1; TODO(F12): tag
   * each problem with a concept at generation time).
   */
  async recordAttempt(
    studentId: string,
    subtopicId: string,
    problemId: string,
    hintsUsed: number,
    answer: string,
  ): Promise<{ id: string; correct: boolean }> {
    // Validate problem belongs to this subtopic.
    const problem = await this.prisma.practiceProblem.findUnique({
      where: { id: problemId },
      select: {
        id: true,
        subtopicId: true,
        solution: true,
        subtopic: { select: { moduleId: true } },
      },
    });
    if (!problem || problem.subtopicId !== subtopicId) {
      throw new NotFoundException("Practice problem not found");
    }

    // Simple string-contains check for correctness — the student's answer
    // string must contain the solution text (case-insensitive). This is
    // deliberately loose for practice; strict grading belongs to quizzes.
    const correct =
      answer.toLowerCase().includes(problem.solution.toLowerCase()) ||
      problem.solution.toLowerCase().includes(answer.toLowerCase());

    // Record the attempt.
    const attempt = await this.prisma.quizAttempt.create({
      data: {
        studentId,
        moduleId: problem.subtopic.moduleId,
        type: "practice_problem",
        question: problemId, // references the practice problem
        answer: `${answer} | hints_used: ${hintsUsed}`,
        correct,
      },
    });

    // ── optional mastery feed ─────────────────────────────────────────
    // Resolve the subtopic's first concept for mastery attribution.
    // TODO(F12): tag practice problems with individual conceptIds at
    // generation time so mastery updates are precise per-concept.
    if (correct) {
      const link = await this.prisma.subtopicConcept.findFirst({
        where: { subtopicId },
        select: { conceptId: true },
      });
      if (link) {
        try {
          await this.mastery.recordQuizResult(
            studentId,
            link.conceptId,
            true,
          );
        } catch {
          // Mastery update is best-effort — never fail the attempt
          // recording because of a mastery write error.
        }
      }
    }

    return { id: attempt.id, correct };
  }
}
