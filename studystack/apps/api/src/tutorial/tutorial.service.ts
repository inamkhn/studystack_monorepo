import { Injectable, NotFoundException } from "@nestjs/common";
import { AiService } from "../ai/ai.service.js";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class TutorialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly courseService: CourseService,
  ) {}

  // ── F6: tutorial fetch (cache-first) ──────────────────────────────────

  async getTutorial(userId: string, subtopicId: string) {
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      include: { module: { include: { course: true } } },
    });

    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    await this.courseService.assertCourseAccess(
      userId,
      subtopic.module.courseId,
    );

    // F3 default level; F18 default persona bucket.
    const level = subtopic.module.course.level ?? "beginner";
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { explanationStyle: true },
    });
    const styleBucket = user?.explanationStyle ?? "neutral";

    const cached = await this.prisma.tutorialContent.findUnique({
      where: {
        subtopicId_level_styleBucket: { subtopicId, level, styleBucket },
      },
    });

    if (cached) {
      return cached;
    }

    // Cache miss — synchronous first-time generation. The in-flight lock for
    // concurrent misses lands with the generation pipeline (F6). Note: a
    // non-neutral persona first requires the neutral row (F18 restyle rule) —
    // enforced inside generation, not here.
    return this.ai.generateTutorial({ subtopicId, level, styleBucket });
  }

  // ── F7: completion tracking ────────────────────────────────────────────

  /**
   * F7 — client-driven "mark complete" for a subtopic. Idempotent upsert;
   * the resulting rows feed the quiz submit gate and the final-project gate.
   */
  async markSubtopicComplete(userId: string, subtopicId: string) {
    const subtopic = await this.prisma.subtopic.findFirst({
      where: { id: subtopicId },
      include: { module: { select: { courseId: true } } },
    });
    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    await this.courseService.assertCourseAccess(
      userId,
      subtopic.module.courseId,
    );

    return this.prisma.subtopicCompletion.upsert({
      where: { studentId_subtopicId: { studentId: userId, subtopicId } },
      create: { studentId: userId, subtopicId },
      update: {},
    });
  }
}
