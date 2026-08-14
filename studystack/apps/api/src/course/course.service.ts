import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Goal, Level } from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, unlink } from "fs/promises";
import * as path from "path";
import { AiService } from "../ai/ai.service.js";
import {
  INGESTION_QUEUE,
  JOB_PRIORITY,
  RESEARCH_QUEUE,
  STRUCTURING_QUEUE,
} from "../jobs/jobs.constants.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { validateUploadFilePath, readFileHead } from "../common/utils/file-validation.js";
import { detectLanguage } from "../common/utils/language-detection.js";
import { setChunkScope, withChunkScope } from "../common/utils/chunk-scope.js";
import {
  deleteCourseAssets,
  resolveStoredPath,
  toStorageKey,
  UPLOAD_DIR,
} from "../common/utils/storage.js";

// ── F1 §4.4: abuse controls (DB-backed — no Redis dependency) ──────────
const MAX_UPLOADS_PER_HOUR = 10;
const MAX_USER_STORAGE_BYTES = 500 * 1024 * 1024; // 500 MB

// ── F1 §4.2: compensation for stranded courses ──────────────────────────
const RECONCILE_STUCK_AFTER_MS = 30 * 60 * 1000;
const FAILED_COURSE_CLEANUP_DAYS = 14;
/** BullMQ job states that mean "a worker will handle this — leave it". */
const LIVE_JOB_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
  "paused",
]);

/** Streaming SHA-256 of a disk file — never buffers the upload in memory. */
function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

@Injectable()
export class CourseService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
    @InjectQueue(RESEARCH_QUEUE) private readonly researchQueue: Queue,
    @InjectQueue(STRUCTURING_QUEUE) private readonly structuringQueue: Queue,
    private readonly ai: AiService,
  ) {}

  // ── F1: upload path ────────────────────────────────────────────────────

  async createUploadCourse(
    userId: string,
    file: Express.Multer.File,
    attestRights?: boolean,
  ) {
    if (!file?.path) {
      throw new BadRequestException("A file upload is required");
    }

    // F1 edge case: corrupted/disguised files are rejected up front with a
    // clear error instead of creating a course that parks in `ingesting`.
    // Path-based because uploads are disk-streamed (never in-memory).
    const kind = await validateUploadFilePath(file.path, file.originalname);

    // F1 §4.4: abuse controls run before any row exists — rate limit,
    // storage quota, and duplicate detection (same content hash under this
    // user = same ingestion cost paid twice).
    await this.assertUploadAllowed(userId, file.size);
    const contentHash = await hashFileSha256(file.path);
    const duplicate = await this.prisma.sourceDocument.findFirst({
      where: { contentHash, course: { ownerId: userId } },
      select: { courseId: true },
    });
    if (duplicate) {
      throw new ConflictException({
        message: "This exact file has already been uploaded",
        existingCourseId: duplicate.courseId,
      });
    }

    // F1 §2.3: detect the source language so generated content stays in it.
    // Plain text is readable now; PDF/DOCX need extraction text, which the
    // AiModule pipeline will detect later (language stays null until then).
    let language: string | null = null;
    if (kind === "text") {
      const head = await readFileHead(file.path, 65536);
      language = detectLanguage(head.toString("utf8"));
    }

    const course = await this.prisma.course.create({
      data: {
        ownerId: userId,
        sourceType: "upload",
        title: file.originalname,
        status: "ingesting",
        ingestionStage: "queued",
        language,
        // F1: optional early attestation at upload time.
        publishAttestationAt: attestRights ? new Date() : undefined,
      },
    });

    let filePath: string | null = null;
    try {
      await mkdir(UPLOAD_DIR, { recursive: true });
      const safeName = file.originalname.replace(/[\\/:*?"<>|]/g, "_");
      filePath = path.join(UPLOAD_DIR, `${course.id}-${safeName}`);
      // Promote the multer temp file to its permanent name — same volume, so
      // this is a cheap rename, not a copy.
      await rename(file.path, filePath);

      await this.prisma.sourceDocument.create({
        data: {
          courseId: course.id,
          // §4.5: stored as a key relative to UPLOAD_DIR (legacy absolute
          // paths still resolve) — portable for the object-storage swap.
          fileUrl: toStorageKey(filePath),
          fileType: path.extname(file.originalname) || null,
          fileSizeBytes: file.size,
          contentHash,
          // Safe default — a student upload is not a rights claim.
          licenseStatus: "user_uploaded_unknown",
        },
      });
    } catch (error) {
      // Don't leave an orphaned ingesting course or file behind if
      // persistence fails. After the rename, file.path is gone — clean up
      // whichever path still exists (§4.3 orphan fix).
      await unlink(file.path).catch(() => undefined);
      if (filePath) {
        await unlink(filePath).catch(() => undefined);
      }
      await this.prisma.course
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
      throw error;
    }

    // F1 resolution: new-course ingestion runs at the highest priority.
    try {
      await this.ingestionQueue.add(
        "ingest-course",
        { courseId: course.id },
        { priority: JOB_PRIORITY.newCourseIngestion, jobId: `ingest:${course.id}` },
      );
    } catch {
      // F1 §4.2: Redis down at enqueue would leave a zombie `ingesting`
      // course with no job and no retry. Roll everything back and surface a
      // clear 503 so the client retries cleanly instead of polling forever.
      await unlink(filePath!).catch(() => undefined);
      await this.prisma.sourceDocument
        .deleteMany({ where: { courseId: course.id } })
        .catch(() => undefined);
      await this.prisma.course
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        "Ingestion queue is unavailable — the upload was rolled back, please retry",
      );
    }

    return course;
  }

  /**
   * F1 §4.4 — per-user upload rate limit + storage quota. DB-backed counts,
   * so they survive restarts and work while Redis is down.
   */
  private async assertUploadAllowed(userId: string, incomingBytes: number) {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [recentUploads, usage] = await Promise.all([
      this.prisma.course.count({
        where: {
          ownerId: userId,
          sourceType: "upload",
          createdAt: { gt: hourAgo },
        },
      }),
      this.prisma.sourceDocument.aggregate({
        _sum: { fileSizeBytes: true },
        where: { course: { ownerId: userId } },
      }),
    ]);

    if (recentUploads >= MAX_UPLOADS_PER_HOUR) {
      throw new HttpException(
        `Upload limit reached (${MAX_UPLOADS_PER_HOUR} uploads/hour) — try again later`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const usedBytes = usage._sum.fileSizeBytes ?? 0;
    if (usedBytes + incomingBytes > MAX_USER_STORAGE_BYTES) {
      throw new PayloadTooLargeException(
        `Storage quota exceeded (max ${MAX_USER_STORAGE_BYTES} bytes per user)`,
      );
    }
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
      // RLS scope: source_chunks access runs under app.current_course_id.
      withChunkScope(this.prisma, courseId, (tx) =>
        tx.sourceChunk.count({ where: { courseId } }),
      ),
    ]);

    return {
      id: course.id,
      title: course.title,
      sourceType: course.sourceType,
      status: course.status,
      // F1 failure contract — populated when status = failed so the client
      // stops polling and can surface the reason.
      ...(course.failureReason ? { failureReason: course.failureReason } : {}),
      // F1 §2.3: detected source language (null = unknown / pending extraction).
      language: course.language ?? null,
      updatedAt: course.updatedAt,
      progress: {
        // F1 §2.2: per-stage progress (queued → extracting → chunking →
        // embedding) alongside the document/chunk counts.
        stage: course.ingestionStage ?? null,
        sourceDocuments,
        sourceChunks,
      },
    };
  }

  /**
   * F1 failure contract: marks the course failed and stamps every source
   * document's extractionStatus. Called by the ingestion worker when the
   * uploaded file proves unreadable/corrupted.
   */
  async failCourseIngestion(courseId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.course.update({
        where: { id: courseId },
        data: { status: "failed", failureReason: reason },
      }),
      this.prisma.sourceDocument.updateMany({
        where: { courseId },
        data: { extractionStatus: "failed" },
      }),
    ]);
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
    try {
      await this.researchQueue.add(
        "research-course",
        { courseId: course.id },
        { priority: JOB_PRIORITY.newCourseIngestion, jobId: `research:${course.id}` },
      );
    } catch {
      // F1 §4.2: never strand a zombie course when the queue is down.
      await this.prisma.course
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        "Research queue is unavailable — please retry",
      );
    }

    return course;
  }

  // ── F3: intake ────────────────────────────────────────────────────────

  async updateIntake(userId: string, courseId: string, goal: Goal, level: Level) {
    const course = await this.requireOwnedCourse(userId, courseId);

    // F3 convergence: intake recorded AND ingestion done → structuring.
    // Recording intake itself never triggers generation; this only advances
    // a course whose ingestion already completed and was parked waiting for
    // goal+level — the F4 structuring job then takes it to `ready`.
    if (course.status === "intake_pending") {
      const updated = await this.prisma.course.update({
        where: { id: courseId },
        data: {
          goal,
          level,
          status: "structuring",
          ingestionStage: "structuring",
        },
      });
      try {
        await this.structuringQueue.add(
          "structure-course",
          { courseId },
          {
            priority: JOB_PRIORITY.newCourseIngestion,
            jobId: `structure:${courseId}`,
            attempts: 2,
            backoff: { type: "exponential", delay: 15_000 },
          },
        );
      } catch {
        // F1 §4.2: the queue went down after the status flip. Revert so the
        // client can retry the same request; reconciliation also picks this
        // up (intake_pending with goal+level → structuring enqueue).
        await this.prisma.course
          .update({
            where: { id: courseId },
            data: { status: "intake_pending", ingestionStage: null },
          })
          .catch(() => undefined);
        throw new ServiceUnavailableException(
          "Structuring queue is unavailable — intake was recorded, please retry",
        );
      }
      return updated;
    }

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

  // ── F1 §4.3: course deletion + file cleanup ─────────────────────────

  /**
   * F1 §4.3 — owner-only hard delete: every DB row plus the uploaded file
   * and extracted figures on disk. Learner-facing dependents (forks,
   * purchases, classrooms, certificates) block deletion instead of
   * cascading into other people's data.
   */
  async deleteCourse(userId: string, courseId: string) {
    await this.requireOwnedCourse(userId, courseId);
    return this.destroyCourse(courseId);
  }

  private async destroyCourse(courseId: string) {
    const [forks, purchases, classrooms, certificates] = await Promise.all([
      this.prisma.courseFork.count({ where: { originalCourseId: courseId } }),
      this.prisma.purchase.count({ where: { courseId } }),
      this.prisma.classroom.count({ where: { courseId } }),
      this.prisma.certificate.count({ where: { courseId } }),
    ]);
    if (forks > 0 || purchases > 0 || classrooms > 0 || certificates > 0) {
      throw new ConflictException(
        "Course has forks, purchases, classrooms, or issued certificates and cannot be deleted",
      );
    }

    const moduleIds = (
      await this.prisma.module.findMany({
        where: { courseId },
        select: { id: true },
      })
    ).map((m) => m.id);
    const subtopicIds =
      moduleIds.length > 0
        ? (
            await this.prisma.subtopic.findMany({
              where: { moduleId: { in: moduleIds } },
              select: { id: true },
            })
          ).map((s) => s.id)
        : [];
    const documents = await this.prisma.sourceDocument.findMany({
      where: { courseId },
      select: { fileUrl: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // RLS scope for the source_chunks delete below.
      await setChunkScope(tx, courseId);
      if (moduleIds.length > 0) {
        await tx.quizAttempt.deleteMany({ where: { moduleId: { in: moduleIds } } });
        await tx.moduleQuiz.deleteMany({ where: { moduleId: { in: moduleIds } } });
      }
      if (subtopicIds.length > 0) {
        await tx.subtopicCompletion.deleteMany({ where: { subtopicId: { in: subtopicIds } } });
        await tx.tutorialContent.deleteMany({ where: { subtopicId: { in: subtopicIds } } });
        await tx.qnaMessage.deleteMany({ where: { subtopicId: { in: subtopicIds } } });
        await tx.practiceProblem.deleteMany({ where: { subtopicId: { in: subtopicIds } } });
        await tx.subtopicConcept.deleteMany({ where: { subtopicId: { in: subtopicIds } } });
        await tx.subtopic.deleteMany({ where: { id: { in: subtopicIds } } });
      }
      if (moduleIds.length > 0) {
        await tx.module.deleteMany({ where: { id: { in: moduleIds } } });
      }
      await tx.sourceChunk.deleteMany({ where: { courseId } });
      await tx.sourceDocument.deleteMany({ where: { courseId } });
      await tx.export.deleteMany({ where: { courseId } });
      await tx.finalProject.deleteMany({ where: { courseId } });
      await tx.courseReport.deleteMany({ where: { courseId } });
      await tx.marketplaceReviewQueue.deleteMany({ where: { courseId } });
      await tx.course.delete({ where: { id: courseId } });
    });

    // Best-effort file cleanup — rows are already gone, so a leftover file
    // here must not fail the delete (the stale-file sweep covers it).
    for (const doc of documents) {
      if (doc.fileUrl) {
        await unlink(resolveStoredPath(doc.fileUrl)).catch(() => undefined);
      }
    }
    await deleteCourseAssets(courseId).catch(() => undefined);

    return { id: courseId, deleted: true };
  }

  // ── F1 §4.2: compensation for stranded courses ───────────────────────

  /**
   * F1 §4.2 — find courses stranded without a live job and re-enqueue them:
   * - ingesting/structuring courses stale past the threshold (worker crash,
   *   exhausted retries, Redis outage mid-flight)
   * - intake_pending courses with goal+level set (structuring enqueue failed
   *   after the status flip)
   *
   * Safe to run repeatedly: jobs still live in their queue are skipped, and
   * ingestion/structuring are idempotent by design. Re-enqueued jobs get a
   * fresh jobId — the original id can linger in completed/failed state.
   */
  async reconcileStuckCourses() {
    const threshold = new Date(Date.now() - RECONCILE_STUCK_AFTER_MS);

    const stuck = await this.prisma.course.findMany({
      where: {
        status: { in: ["ingesting", "structuring"] },
        updatedAt: { lt: threshold },
      },
      select: { id: true, status: true },
    });
    const parked = await this.prisma.course.findMany({
      where: {
        status: "intake_pending",
        goal: { not: null },
        level: { not: null },
        updatedAt: { lt: threshold },
      },
      select: { id: true },
    });

    const enqueue = async (
      queue: Queue,
      name: string,
      baseJobId: string,
      courseId: string,
    ): Promise<boolean> => {
      try {
        const existing = await queue.getJob(baseJobId);
        if (existing && LIVE_JOB_STATES.has(await existing.getState())) {
          return false; // still live — leave it alone
        }
        await queue.add(
          name,
          { courseId },
          {
            priority: JOB_PRIORITY.newCourseIngestion,
            jobId: `${baseJobId}:rec-${Date.now()}`,
            attempts: 2,
            backoff: { type: "exponential", delay: 15_000 },
          },
        );
        return true;
      } catch {
        return false; // Redis down — try again next cycle
      }
    };

    let requeued = 0;
    const skipped: string[] = [];

    for (const course of stuck) {
      const ok =
        course.status === "ingesting"
          ? await enqueue(this.ingestionQueue, "ingest-course", `ingest:${course.id}`, course.id)
          : await enqueue(this.structuringQueue, "structure-course", `structure:${course.id}`, course.id);
      if (ok) requeued += 1;
      else skipped.push(course.id);
    }
    for (const course of parked) {
      const ok = await enqueue(
        this.structuringQueue,
        "structure-course",
        `structure:${course.id}`,
        course.id,
      );
      if (ok) requeued += 1;
      else skipped.push(course.id);
    }

    return { checked: stuck.length + parked.length, requeued, skipped };
  }

  /**
   * F1 §4.3 — TTL sweep: hard-delete courses stuck in `failed` past the
   * retention window, so corrupted uploads don't linger on disk forever.
   */
  async cleanupFailedCourses(
    olderThanDays: number = FAILED_COURSE_CLEANUP_DAYS,
  ) {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const failed = await this.prisma.course.findMany({
      where: { status: "failed", updatedAt: { lt: cutoff } },
      select: { id: true },
    });

    let removed = 0;
    for (const course of failed) {
      try {
        await this.destroyCourse(course.id);
        removed += 1;
      } catch {
        // Learner-facing dependents or a transient error — leave it for the
        // next sweep.
      }
    }

    return { found: failed.length, removed };
  }

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
