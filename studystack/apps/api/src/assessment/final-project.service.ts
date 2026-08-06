import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AiService } from "../ai/ai.service.js";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { FinalProjectSubmitDto } from "./dto/final-project-submit.dto.js";

/**
 * F9 — final project. Generated once per course on first GET (cached in
 * `final_projects`), gated on completion of every module in the course.
 * Submissions reuse `quiz_attempts` with type = final_project — no dedicated
 * table, per the endpoints doc's settled data model.
 */
@Injectable()
export class FinalProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly courseService: CourseService,
  ) {}

  async getFinalProject(userId: string, courseId: string) {
    await this.courseService.assertCourseAccess(userId, courseId);
    await this.assertCourseComplete(userId, courseId);

    const existing = await this.prisma.finalProject.findUnique({
      where: { courseId },
    });
    if (existing) {
      return { courseId, prompt: existing.prompt };
    }

    const [course, concepts] = await Promise.all([
      this.prisma.course.findUniqueOrThrow({
        where: { id: courseId },
        select: { title: true },
      }),
      this.collectCourseConcepts(courseId),
    ]);

    const prompt = await this.ai.generateFinalProjectPrompt({
      courseId,
      courseTitle: course.title,
      concepts,
    });

    let row;
    try {
      row = await this.prisma.finalProject.create({
        data: { courseId, prompt },
      });
    } catch (error) {
      // Concurrent first GET — another request won the create race;
      // serve its row instead of failing with a P2002 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.prisma.finalProject.findUnique({
          where: { courseId },
        });
        if (!winner) {
          throw new InternalServerErrorException(
            "Final-project race condition — winning row disappeared",
          );
        }
        row = winner;
      } else {
        throw error;
      }
    }
    return { courseId, prompt: row.prompt };
  }

  async submitFinalProject(
    userId: string,
    courseId: string,
    dto: FinalProjectSubmitDto,
  ) {
    await this.courseService.assertCourseAccess(userId, courseId);
    await this.assertCourseComplete(userId, courseId);

    const stored = await this.prisma.finalProject.findUnique({
      where: { courseId },
    });
    if (!stored) {
      throw new NotFoundException(
        "No project to submit against — generate it first (GET /courses/:id/final-project)",
      );
    }

    // quiz_attempts.moduleId is required; the project spans the whole course,
    // so it's attributed to the course's last module (max order).
    const lastModule = await this.prisma.module.findFirst({
      where: { courseId },
      orderBy: { order: "desc" },
      select: { id: true },
    });
    if (!lastModule) {
      throw new BadRequestException("Course has no modules");
    }

    // Classroom mode (F19): carry the student's fork_id when one exists.
    const fork = await this.prisma.courseFork.findFirst({
      where: { studentId: userId, originalCourseId: courseId },
      select: { id: true },
    });

    // correct=true = accepted submission. F9 is reflective, not strict
    // grading — the optional LLM feedback pass wires in with AiModule.
    return this.prisma.quizAttempt.create({
      data: {
        studentId: userId,
        moduleId: lastModule.id,
        conceptId: null, // spans multiple concepts — untagged by design
        forkId: fork?.id,
        type: "final_project",
        question: stored.prompt,
        answer: dto.answer,
        correct: true,
      },
    });
  }

  // ── gates & helpers ────────────────────────────────────────────────────

  /** F9 gate: every subtopic of every module in the course must be complete. */
  private async assertCourseComplete(studentId: string, courseId: string) {
    const [subtopics, completions] = await Promise.all([
      this.prisma.subtopic.findMany({
        where: { module: { courseId } },
        select: { id: true },
      }),
      this.prisma.subtopicCompletion.findMany({
        where: { studentId, subtopic: { module: { courseId } } },
        select: { subtopicId: true },
      }),
    ]);

    if (subtopics.length === 0) {
      throw new ForbiddenException("This course has no subtopics yet");
    }
    if (completions.length < subtopics.length) {
      throw new ForbiddenException(
        "Complete every module in this course before starting the final project",
      );
    }
  }

  /** Distinct concepts across the whole course (from F4's mappings). */
  private async collectCourseConcepts(
    courseId: string,
  ): Promise<{ conceptId: string; canonicalName: string }[]> {
    const rows = await this.prisma.subtopicConcept.findMany({
      where: { subtopic: { module: { courseId } } },
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
}
