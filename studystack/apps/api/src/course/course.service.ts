import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Goal, Level } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { AiService } from "../ai/ai.service.js";
import {
  INGESTION_QUEUE,
  JOB_PRIORITY,
  RESEARCH_QUEUE,
} from "../jobs/jobs.constants.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class CourseService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
    @InjectQueue(RESEARCH_QUEUE) private readonly researchQueue: Queue,
    private readonly ai: AiService,
  ) {}

  // ── F1: upload path ────────────────────────────────────────────────────

  async createUploadCourse(
    userId: string,
    file: Express.Multer.File,
    attestRights?: boolean,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("A file upload is required");
    }

    const course = await this.prisma.course.create({
      data: {
        ownerId: userId,
        sourceType: "upload",
        title: file.originalname,
        status: "ingesting",
        // F1: optional early attestation at upload time.
        publishAttestationAt: attestRights ? new Date() : undefined,
      },
    });

    // Persist locally until object storage (S3/R2) is wired — later step.
    try {
      const uploadDir = path.join(process.cwd(), "uploads");
      await mkdir(uploadDir, { recursive: true });
      const safeName = file.originalname.replace(/[\\/:*?"<>|]/g, "_");
      const filePath = path.join(uploadDir, `${course.id}-${safeName}`);
      await writeFile(filePath, file.buffer);

      await this.prisma.sourceDocument.create({
        data: {
          courseId: course.id,
          fileUrl: filePath,
          fileType: path.extname(file.originalname) || null,
          // Safe default — a student upload is not a rights claim.
          licenseStatus: "user_uploaded_unknown",
        },
      });
    } catch (error) {
      // Don't leave an orphaned ingesting course behind if persistence fails.
      await this.prisma.course
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
      throw error;
    }

    // F1 resolution: new-course ingestion runs at the highest priority.
    await this.ingestionQueue.add(
      "ingest-course",
      { courseId: course.id },
      { priority: JOB_PRIORITY.newCourseIngestion, jobId: `ingest:${course.id}` },
    );

    return course;
  }

  // ── F1: rights attestation (idempotent) ───────────────────────────────

  async attestRights(userId: string, courseId: string) {
    const course = await this.requireOwnedCourse(userId, courseId);

    if (course.publishAttestationAt) {
      return course; // already attested — idempotent no-op
    }

    return this.prisma.course.update({
      where: { id: courseId },
      data: { publishAttestationAt: new Date() },
    });
  }

  // ── F1: ingestion progress polling ────────────────────────────────────

  async getIngestionStatus(userId: string, courseId: string) {
    const course = await this.getAccessibleCourseOrThrow(userId, courseId);

    const [sourceDocuments, sourceChunks] = await Promise.all([
      this.prisma.sourceDocument.count({ where: { courseId } }),
      this.prisma.sourceChunk.count({ where: { courseId } }),
    ]);

    return {
      id: course.id,
      title: course.title,
      sourceType: course.sourceType,
      status: course.status,
      updatedAt: course.updatedAt,
      progress: { sourceDocuments, sourceChunks },
    };
  }

  // ── F2: topic-only path ───────────────────────────────────────────────

  async createTopicCourse(userId: string, topic: string) {
    const course = await this.prisma.course.create({
      data: {
        ownerId: userId,
        sourceType: "topic",
        topic,
        title: topic,
        status: "ingesting",
      },
    });

    // F2: research step runs before converging into module generation.
    await this.researchQueue.add(
      "research-course",
      { courseId: course.id },
      { priority: JOB_PRIORITY.newCourseIngestion, jobId: `research:${course.id}` },
    );

    return course;
  }

  // ── F3: intake ────────────────────────────────────────────────────────

  async updateIntake(userId: string, courseId: string, goal: Goal, level: Level) {
    await this.requireOwnedCourse(userId, courseId);

    // Recording intake does NOT trigger structure generation itself — the
    // internal completion check (intake recorded AND ingestion/research done)
    // drives the structuring transition (endpoints doc, F3).
    return this.prisma.course.update({
      where: { id: courseId },
      data: { goal, level },
    });
  }

  // ── F3: mid-course level change ───────────────────────────────────────

  async updateLevel(userId: string, courseId: string, level: Level) {
    const course = await this.requireOwnedCourse(userId, courseId);

    if (course.level === level) {
      return course; // no-op
    }

    // levelChangedAt lets the client distinguish content generated under the
    // current level from older content. Re-generation of not-yet-completed
    // subtopics is queued internally once completion semantics exist
    // (AiModule step) — this endpoint only records the change.
    return this.prisma.course.update({
      where: { id: courseId },
      data: { level, levelChangedAt: new Date() },
    });
  }

  // ── F3: mid-course goal change ────────────────────────────────────────

  async updateGoal(userId: string, courseId: string, goal: Goal) {
    const course = await this.requireOwnedCourse(userId, courseId);

    if (course.goal === goal) {
      return course; // no-op
    }

    // goal only affects future review-interval scheduling (F8) — it never
    // touches existing tutorial_content.
    return this.prisma.course.update({
      where: { id: courseId },
      data: { goal },
    });
  }

  // ── F3: exam date (goal = exam_prep only) ─────────────────────────────

  async updateExamDate(userId: string, courseId: string, examDate: string | null) {
    const course = await this.requireOwnedCourse(userId, courseId);

    if (examDate !== null && course.goal !== "exam_prep") {
      throw new BadRequestException(
        "examDate is only applicable when goal = exam_prep",
      );
    }

    return this.prisma.course.update({
      where: { id: courseId },
      data: { examDate: examDate ? new Date(examDate) : null },
    });
  }

  // ── F4: generated structure read ──────────────────────────────────────

  async getStructure(userId: string, courseId: string) {
    await this.getAccessibleCourseOrThrow(userId, courseId);

    return this.prisma.module.findMany({
      where: { courseId },
      orderBy: { order: "asc" },
      include: {
        subtopics: {
          orderBy: { order: "asc" },
          include: { subtopicConcepts: { include: { concept: true } } },
        },
      },
    });
  }

  // ── F6: tutorial fetch (cache-first) ──────────────────────────────────

  async getTutorial(userId: string, subtopicId: string) {
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      include: { module: { include: { course: true } } },
    });

    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    await this.getAccessibleCourseOrThrow(userId, subtopic.module.courseId);

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

  // ── F15: concept links for a subtopic ─────────────────────────────────

  async getConceptLinks(userId: string, courseId: string, subtopicId: string) {
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      include: { module: true },
    });

    if (!subtopic || subtopic.module.courseId !== courseId) {
      throw new NotFoundException("Subtopic not found in course");
    }

    await this.getAccessibleCourseOrThrow(userId, courseId);

    const links = await this.prisma.subtopicConcept.findMany({
      where: { subtopicId },
      include: { concept: true },
    });

    const conceptIds = links.map((link) => link.conceptId);

    const [mastery, otherLocations] = await Promise.all([
      this.prisma.masteryScore.findMany({
        where: { studentId: userId, conceptId: { in: conceptIds } },
      }),
      // Other subtopics of the student's courses sharing any of these concepts.
      this.prisma.subtopicConcept.findMany({
        where: {
          conceptId: { in: conceptIds },
          subtopicId: { not: subtopicId },
          subtopic: {
            module: {
              course: {
                OR: [
                  { ownerId: userId },
                  { courseForks: { some: { studentId: userId } } },
                ],
              },
            },
          },
        },
        include: {
          subtopic: { include: { module: { include: { course: true } } } },
        },
      }),
    ]);

    return {
      subtopicId,
      concepts: links.map((link) => ({
        conceptId: link.conceptId,
        canonicalName: link.concept.canonicalName,
        mastery: mastery.find((m) => m.conceptId === link.conceptId) ?? null,
        otherLocations: otherLocations
          .filter((location) => location.conceptId === link.conceptId)
          .map((location) => ({
            courseId: location.subtopic.module.courseId,
            courseTitle: location.subtopic.module.course.title,
            subtopicId: location.subtopicId,
            subtopicTitle: location.subtopic.title,
          })),
      })),
    };
  }

  // ── F14: publish a course (provenance gate + age_bracket guard) ────────

  /**
   * Runs the copyright/provenance gate for a course.
   *
   * Full scan if `publish_gate_checked_at` is null, incremental (rows
   * generated since the last check) otherwise.
   *
   * Public so MarketplaceService (F17) can reuse the same gate without
   * duplicating the scan logic.
   */
  async runProvenanceGate(
    courseId: string,
  ): Promise<{ passed: boolean; offendingSubtopicIds: string[] }> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { publishGateCheckedAt: true },
    });
    if (!course) {
      throw new NotFoundException("Course not found");
    }

    // If the course has no upload-provenance content at all, it always passes.
    const whereProvenance = {
      subtopic: { module: { courseId } },
      provenance: "reused_from_upload" as const,
      ...(course.publishGateCheckedAt
        ? { generatedAt: { gt: course.publishGateCheckedAt } }
        : {}),
    };

    const reusedCount = await this.prisma.tutorialContent.count({
      where: whereProvenance,
    });

    if (reusedCount === 0) {
      return { passed: true, offendingSubtopicIds: [] };
    }

    // Upload-provenance content exists — check source-document license status.
    const hasUnknownLicense =
      (await this.prisma.sourceDocument.count({
        where: { courseId, licenseStatus: "user_uploaded_unknown" },
      })) > 0;

    if (!hasUnknownLicense) {
      return { passed: true, offendingSubtopicIds: [] };
    }

    // Gate blocked — return the specific subtopics that triggered it.
    const offending = await this.prisma.tutorialContent.findMany({
      where: whereProvenance,
      select: { subtopicId: true },
      distinct: ["subtopicId"],
    });

    return {
      passed: false,
      offendingSubtopicIds: offending.map((r) => r.subtopicId),
    };
  }

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

    const course = await this.requireOwnedCourse(userId, courseId);

    if (course.status !== "ready") {
      throw new BadRequestException(
        "Course is not yet ready — wait for ingestion and structuring to complete",
      );
    }

    // Provenance gate.
    const gate = await this.runProvenanceGate(courseId);
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

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Public access assertion for other modules (AssessmentModule quiz/final
   * project reads the same owner-or-fork surface).
   */
  async assertCourseAccess(userId: string, courseId: string): Promise<void> {
    await this.getAccessibleCourseOrThrow(userId, courseId);
  }

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

    await this.assertCourseAccess(userId, subtopic.module.courseId);

    return this.prisma.subtopicCompletion.upsert({
      where: { studentId_subtopicId: { studentId: userId, subtopicId } },
      create: { studentId: userId, subtopicId },
      update: {},
    });
  }

  /** Mutations are owner-only. */
  async requireOwnedCourse(userId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ownerId: userId },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    return course;
  }

  /**
   * Reads allow owner OR classroom-fork participants (F14/F19 compatible —
   * forks don't exist yet, so behaviour is identical today).
   */
  private async getAccessibleCourseOrThrow(userId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        OR: [
          { ownerId: userId },
          { courseForks: { some: { studentId: userId } } },
        ],
      },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    return course;
  }
}
