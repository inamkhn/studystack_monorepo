import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Goal, Level } from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ProvenanceGateService } from "./provenance-gate.service.js";

/**
 * F14 — course sharing: publish (provenance gate + age guard), public
 * browse, fork, and reports. Mutations keep the same owner-or-404 semantics
 * as the rest of the course surface via CourseService.requireOwnedCourse.
 */
@Injectable()
export class CourseShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseService: CourseService,
    private readonly provenanceGate: ProvenanceGateService,
  ) {}

  // ── F14: publish a course (provenance gate + age_bracket guard) ────────

  async publishCourse(userId: string, courseId: string) {
    // F14 / F19: publishing is unavailable to non-adult accounts.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ageBracket: true },
    });
    if (user?.ageBracket !== "adult") {
      throw new ForbiddenException(
        "Publishing is only available to adult accounts",
      );
    }

    const course = await this.courseService.requireOwnedCourse(userId, courseId);

    if (course.status !== "ready") {
      throw new BadRequestException(
        "Course is not yet ready — wait for ingestion and structuring to complete",
      );
    }

    // Provenance gate.
    const gate = await this.provenanceGate.runProvenanceGate(courseId);
    if (!gate.passed) {
      throw new BadRequestException(
        `Cannot publish: copyright is unclear for ${gate.offendingSubtopicIds.length} subtopic(s). ` +
          "Resolve license status on uploaded source material first.",
      );
    }

    // Already published — idempotent no-op (update timestamp on re-publish).
    const now = new Date();
    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        visibility: "public_shared",
        publishedAt: course.publishedAt ?? now,
        publishGateCheckedAt: now,
      },
    });
  }

  // ── F14: public course browse ──────────────────────────────────────────

  async browsePublicCourses(filters?: {
    subject?: string;
    level?: Level;
    goal?: Goal;
  }) {
    const where: Record<string, unknown> = { visibility: "public_shared" };

    if (filters?.subject) {
      // Subject is stored in `topic` — fuzzy match.
      where.topic = { contains: filters.subject, mode: "insensitive" };
    }
    if (filters?.level) {
      where.level = filters.level;
    }
    if (filters?.goal) {
      where.goal = filters.goal;
    }

    return this.prisma.course.findMany({
      where,
      select: {
        id: true,
        title: true,
        topic: true,
        goal: true,
        level: true,
        description: true,
        publishedAt: true,
        owner: { select: { name: true } },
      },
      orderBy: { publishedAt: "desc" },
      take: 100,
    });
  }

  // ── F14: fork a public course (non-owner viewer) ───────────────────────

  async forkCourse(userId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, ownerId: true, visibility: true },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    if (course.ownerId === userId) {
      throw new BadRequestException("You cannot fork your own course");
    }

    if (course.visibility !== "public_shared") {
      throw new BadRequestException("Only public courses can be forked");
    }

    // Check for an existing fork — idempotent.
    const existing = await this.prisma.courseFork.findFirst({
      where: { originalCourseId: courseId, studentId: userId },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.courseFork.create({
        data: {
          originalCourseId: courseId,
          studentId: userId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Concurrent fork — another request created one between our
        // findFirst check and this create. Return the winner's row.
        return this.prisma.courseFork.findFirstOrThrow({
          where: { originalCourseId: courseId, studentId: userId },
          select: { id: true, createdAt: true },
        });
      }
      throw error;
    }
  }

  // ── F14: report a course ───────────────────────────────────────────────

  async reportCourse(userId: string, courseId: string, reason: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, visibility: true },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    if (course.visibility !== "public_shared") {
      throw new BadRequestException("Only public courses can be reported");
    }

    return this.prisma.courseReport.create({
      data: {
        courseId,
        reporterId: userId,
        reason,
      },
    });
  }
}
