import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Goal, Level } from "../generated/prisma/client.js";
import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, unlink } from "fs/promises";
import * as path from "path";
import { StorageService } from "../storage/storage.service.js";
import {
  INGESTION_QUEUE,
  JOB_PRIORITY,
  RESEARCH_QUEUE,
  STRUCTURING_QUEUE,
} from "../jobs/jobs.constants.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { validateUploadFilePath } from "../common/utils/file-validation.js";
import { withChunkScope } from "../common/utils/chunk-scope.js";
import {
  toStorageKey,
  UPLOAD_DIR,
} from "../common/utils/storage.js";

// ── F1 §4.4: abuse controls (DB-backed — no Redis dependency) ──────────
const MAX_UPLOADS_PER_HOUR = 10;
const MAX_USER_STORAGE_BYTES = 500 * 1024 * 1024; // 500 MB

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
    private readonly storage: StorageService,
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
    await validateUploadFilePath(file.path, file.originalname);

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

    const course = await this.prisma.course.create({
      data: {
        ownerId: userId,
        sourceType: "upload",
        title: file.originalname,
        status: "ingesting",
        ingestionStage: "queued",
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

  // ── F1: S3 presigned upload (browser PUTs direct to AWS, virtual-hosted) ─
  // Legacy multipart POST /courses/upload keeps working (local disk + small
  // files). This flow reserves the course row first so quota/dedupe still
  // run before any bytes move, then confirm() verifies content + enqueues.

  async presignUpload(
    userId: string,
    opts: {
      filename: string;
      contentType: string;
      sizeBytes: number;
      attestRights?: boolean;
    },
  ) {
    if (this.storage.getDriver() !== "s3") {
      throw new ServiceUnavailableException(
        "Presigned uploads require STORAGE_DRIVER=s3 — use multipart POST /courses/upload",
      );
    }

    const ext = path.extname(opts.filename ?? "").toLowerCase();
    if (![".pdf", ".docx", ".txt", ".md"].includes(ext)) {
      throw new BadRequestException(
        "Only PDF, DOCX, and plain-text (.txt / .md) files are supported",
      );
    }

    await this.assertUploadAllowed(userId, opts.sizeBytes);

    const course = await this.prisma.course.create({
      data: {
        ownerId: userId,
        sourceType: "upload",
        title: opts.filename,
        status: "ingesting",
        ingestionStage: "awaiting-upload",
        publishAttestationAt: opts.attestRights ? new Date() : undefined,
      },
    });

    const safeName = opts.filename.replace(/[\\/:*?"<>|]/g, "_");
    const key = `${course.id}-${safeName}`;

    try {
      await this.prisma.sourceDocument.create({
        data: {
          courseId: course.id,
          fileUrl: key,
          fileType: ext || null,
          fileSizeBytes: opts.sizeBytes,
          licenseStatus: "user_uploaded_unknown",
          extractionStatus: "awaiting-upload",
        },
      });
      const { url, expiresIn } = await this.storage.presignPut(
        key,
        opts.contentType,
      );
      return { courseId: course.id, key, uploadUrl: url, expiresIn };
    } catch (error) {
      await this.prisma.sourceDocument
        .deleteMany({ where: { courseId: course.id } })
        .catch(() => undefined);
      await this.prisma.course
        .delete({ where: { id: course.id } })
        .catch(() => undefined);
      throw error;
    }
  }

  async confirmUpload(userId: string, courseId: string) {
    const course = await this.requireOwnedCourse(userId, courseId);
    if (
      course.status === "ingesting" &&
      course.ingestionStage !== "awaiting-upload"
    ) {
      return course; // idempotent — already confirmed/queued
    }

    const document = await this.prisma.sourceDocument.findFirst({
      where: { courseId },
    });
    if (!document?.fileUrl) {
      throw new BadRequestException("No pending upload for this course");
    }

    const size = await this.storage.headSize(document.fileUrl);
    if (!size) {
      throw new BadRequestException(
        "Uploaded file not found in storage — re-upload via a fresh presigned URL",
      );
    }

    const head = await this.storage.getHeadBytes(document.fileUrl, 8192);
    const { sniffFileKind } = await import(
      "../common/utils/file-validation.js"
    );
    const ext = path.extname(course.title ?? "").toLowerCase();
    const claimed =
      ext === ".pdf"
        ? "pdf"
        : ext === ".docx"
          ? "docx"
          : ext === ".txt" || ext === ".md"
            ? "text"
            : null;
    if (!claimed || sniffFileKind(head) !== claimed) {
      throw new BadRequestException(
        `File content does not match its "${ext}" extension — the upload appears corrupted or mislabelled`,
      );
    }

    await this.prisma.sourceDocument.updateMany({
      where: { courseId },
      data: { extractionStatus: null, fileSizeBytes: size },
    });
    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status: "ingesting", ingestionStage: "queued" },
    });

    try {
      await this.ingestionQueue.add(
        "ingest-course",
        { courseId },
        { priority: JOB_PRIORITY.newCourseIngestion, jobId: `ingest:${courseId}` },
      );
    } catch {
      throw new ServiceUnavailableException(
        "Ingestion queue is unavailable — upload confirmed, retry confirmation shortly",
      );
    }

    return updated;
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

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Public access assertion for other modules (AssessmentModule quiz/final
   * project reads the same owner-or-fork surface).
   */
  async assertCourseAccess(userId: string, courseId: string): Promise<void> {
    await this.getAccessibleCourseOrThrow(userId, courseId);
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
