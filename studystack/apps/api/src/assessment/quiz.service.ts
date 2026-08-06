import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { QuizQuestion } from "../ai/ai.service.js";
import { AiService } from "../ai/ai.service.js";
import { CourseService } from "../course/course.service.js";
import { MasteryService } from "../mastery/mastery.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { QuizSubmitDto } from "./dto/quiz-submit.dto.js";

/** Server-side half of each graded question. */
interface GradedResult {
  question: QuizQuestion;
  answer: string;
  correct: boolean;
  rationale?: string;
}

/**
 * F7 — module quiz. Design decisions locked with the product:
 * - Per-student generation: every GET regenerates the quiz (anti-predictability)
 *   and replaces the stored copy; submit grades against that stored copy.
 * - GET is gated on module completion too — students can't preview questions
 *   before finishing the module's subtopics (stricter than the spec's submit-only
 *   wording, decided explicitly).
 * - Single submission: after submit, stored quiz is locked via submittedAt.
 *   GET returns the submitted quiz for review (no regeneration), submit rejects
 *   re-submission. This caps LLM cost per module to one generation cycle.
 * - Mastery is best-effort: logged on failure, eventually-consistent via F8 scheduler.
 */
@Injectable()
export class QuizService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly courseService: CourseService,
    private readonly mastery: MasteryService,
  ) {}

  async getQuiz(userId: string, moduleId: string) {
    const module = await this.loadModuleOrThrow(moduleId);
    await this.courseService.assertCourseAccess(userId, module.courseId);
    await this.assertModuleComplete(userId, moduleId);

    const existing = await this.prisma.moduleQuiz.findUnique({
      where: { studentId_moduleId: { studentId: userId, moduleId } },
    });
    if (existing?.submittedAt) {
      const existingQuestions =
        existing.questions as unknown as QuizQuestion[];
      return {
        moduleId,
        questions: existingQuestions.map(publicQuestion),
        submitted: true,
      };
    }

    const concepts = await this.collectModuleConcepts(moduleId);

    const questions = await this.ai.generateModuleQuiz({
      moduleId,
      level: module.course.level ?? "beginner",
      concepts,
    });

    // F7 contract, enforced server-side: generation selects from the module's
    // existing subtopic_concepts mappings only — a question referencing a
    // concept outside that set would otherwise fail as an FK violation deep
    // inside the submit transaction once the real pipeline lands.
    const validConceptIds = new Set(concepts.map((c) => c.conceptId));
    for (const q of questions) {
      if (!validConceptIds.has(q.conceptId)) {
        throw new BadRequestException(
          `Generated question ${q.id} references concept ${q.conceptId} which is not mapped to this module`,
        );
      }
      if (q.type !== "recall" && q.type !== "applied") {
        throw new BadRequestException(
          `Question ${q.id}: unknown type "${q.type}" (expected recall or applied)`,
        );
      }
      if (q.type === "recall" && !q.answerKey) {
        throw new BadRequestException(
          `Recall question ${q.id} is missing an answerKey`,
        );
      }
      if (q.type === "applied" && !q.rubric) {
        throw new BadRequestException(
          `Applied question ${q.id} is missing a grading rubric`,
        );
      }
    }

    if (questions.length === 0) {
      throw new BadRequestException(
        "Generated quiz has no questions — the module may have no concept mappings yet",
      );
    }

    const questionsJson = questions as unknown as Prisma.InputJsonValue;
    await this.prisma.moduleQuiz.upsert({
      where: { studentId_moduleId: { studentId: userId, moduleId } },
      create: { studentId: userId, moduleId, questions: questionsJson },
      update: { questions: questionsJson },
    });

    return {
      moduleId,
      questions: questions.map(publicQuestion),
    };
  }

  async submitQuiz(userId: string, moduleId: string, dto: QuizSubmitDto) {
    const module = await this.loadModuleOrThrow(moduleId);
    await this.courseService.assertCourseAccess(userId, module.courseId);
    // The spec's explicit server-side gate — fires here, not at GET.
    await this.assertModuleComplete(userId, moduleId);

    const stored = await this.prisma.moduleQuiz.findUnique({
      where: { studentId_moduleId: { studentId: userId, moduleId } },
    });
    if (!stored) {
      throw new NotFoundException(
        "No quiz to grade — generate it first (GET /modules/:id/quiz)",
      );
    }
    if (stored.submittedAt) {
      throw new BadRequestException(
        `Quiz was already submitted on ${stored.submittedAt.toISOString()}`,
      );
    }

    const questions = stored.questions as unknown as QuizQuestion[];
    const byId = new Map(questions.map((q) => [q.id, q]));
    const submittedIds = dto.answers.map((a) => a.questionId);
    // Exact cover: every question answered exactly once — a length check alone
    // would accept [{q1,a},{q1,b}] against a 2-question quiz and skip q2.
    if (
      submittedIds.length !== questions.length ||
      new Set(submittedIds).size !== questions.length ||
      submittedIds.some((id) => !byId.has(id))
    ) {
      throw new BadRequestException("Answer every question exactly once");
    }

    // Grade everything before writing anything — an LLM-grading failure must
    // not leave a partial quiz_attempts set behind.
    const graded: GradedResult[] = [];
    for (const { questionId, answer } of dto.answers) {
      const question = byId.get(questionId);
      if (!question) {
        throw new BadRequestException(`Unknown question id: ${questionId}`);
      }
      graded.push(await this.grade(question, answer));
    }

    if (graded.length === 0) {
      throw new BadRequestException("Quiz has no questions to grade");
    }

    // Classroom mode (F19): rows carry the student's fork_id when one exists.
    const fork = await this.prisma.courseFork.findFirst({
      where: { studentId: userId, originalCourseId: module.courseId },
      select: { id: true },
    });

    await this.prisma.$transaction(
      graded.map((r) =>
        this.prisma.quizAttempt.create({
          data: {
            studentId: userId,
            moduleId,
            conceptId: r.question.conceptId,
            forkId: fork?.id,
            type: "module_quiz",
            question: r.question.prompt,
            answer: r.answer,
            rationale: r.rationale,
            correct: r.correct,
          },
        }),
      ),
    );

    // Mark quiz as submitted — prevents double-submit and re-generation.
    await this.prisma.moduleQuiz.update({
      where: { studentId_moduleId: { studentId: userId, moduleId } },
      data: { submittedAt: new Date() },
    });

    // F8 trigger — per concept_id, never per module.
    for (const r of graded) {
      try {
        await this.mastery.recordQuizResult(
          userId,
          r.question.conceptId,
          r.correct,
        );
      } catch (error) {
        // Mastery is eventually-consistent via the F8 scheduler — log and continue.
        console.error(
          `Mastery update failed for concept ${r.question.conceptId} (user ${userId}):`,
          error,
        );
      }
    }

    const correctCount = graded.filter((r) => r.correct).length;
    return {
      moduleId,
      score: correctCount / graded.length,
      results: graded.map((r) => ({
        questionId: r.question.id,
        correct: r.correct,
        rationale: r.rationale,
      })),
    };
  }

  // ── grading ────────────────────────────────────────────────────────────

  /** Recall: normalized exact match. Applied: LLM-graded against the rubric. */
  private async grade(question: QuizQuestion, answer: string): Promise<GradedResult> {
    if (question.type === "recall") {
      const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
      return {
        question,
        answer,
        correct: normalize(answer) === normalize(question.answerKey ?? ""),
      };
    }

    const { correct, rationale } = await this.ai.gradeAppliedAnswer({
      prompt: question.prompt,
      rubric: question.rubric ?? "",
      answer,
    });
    return { question, answer, correct, rationale };
  }

  // ── gates & helpers ────────────────────────────────────────────────────

  /** The F7 completion gate: every subtopic in the module must be marked done. */
  private async assertModuleComplete(studentId: string, moduleId: string) {
    const [subtopics, completions] = await Promise.all([
      this.prisma.subtopic.findMany({
        where: { moduleId },
        select: { id: true },
      }),
      this.prisma.subtopicCompletion.findMany({
        where: { studentId, subtopic: { moduleId } },
        select: { subtopicId: true },
      }),
    ]);

    if (subtopics.length === 0) {
      throw new ForbiddenException("This module has no subtopics yet");
    }
    if (completions.length < subtopics.length) {
      throw new ForbiddenException(
        "Complete every subtopic in this module before taking the quiz",
      );
    }
  }

  /** Distinct concepts mapped to this module's subtopics (F4's mappings only). */
  private async collectModuleConcepts(
    moduleId: string,
  ): Promise<{ conceptId: string; canonicalName: string }[]> {
    const rows = await this.prisma.subtopicConcept.findMany({
      where: { subtopic: { moduleId } },
      select: { conceptId: true, concept: { select: { canonicalName: true } } },
    });
    const unique = new Map<string, string>();
    for (const row of rows) {
      unique.set(row.conceptId, row.concept.canonicalName);
    }
    return [...unique].map(([conceptId, canonicalName]) => ({
      conceptId,
      canonicalName,
    }));
  }

  private async loadModuleOrThrow(moduleId: string) {
    const module = await this.prisma.module.findFirst({
      where: { id: moduleId },
      include: { course: { select: { level: true } } },
    });
    if (!module) {
      throw new NotFoundException("Module not found");
    }
    return module;
  }
}

/** Answer key / rubric never leave the server. */
function publicQuestion(q: QuizQuestion) {
  return { id: q.id, type: q.type, prompt: q.prompt, conceptId: q.conceptId };
}
