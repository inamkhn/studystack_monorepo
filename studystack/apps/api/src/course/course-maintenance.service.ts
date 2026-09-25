import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { StorageService } from "../storage/storage.service.js";
import {
  INGESTION_QUEUE,
  JOB_PRIORITY,
  STRUCTURING_QUEUE,
} from "../jobs/jobs.constants.js";
import { setChunkScope } from "../common/utils/chunk-scope.js";
import { PrismaService } from "../prisma/prisma.service.js";

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

/**
 * F1 §4.2/§4.3 — operational lifecycle surface: failure stamping (called by
 * the ingestion worker contract), owner deletes, reconciliation of stranded
 * courses, and the failed-course TTL sweep. Separated from CourseService
 * (creation/intake lifecycle) because these are recovery/cleanup workflows
 * with queue-state awareness, not request-path CRUD.
 */
@Injectable()
export class CourseMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
    @InjectQueue(STRUCTURING_QUEUE) private readonly structuringQueue: Queue,
    private readonly storage: StorageService,
  ) {}

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

  // ── F1 §4.3: course deletion + file cleanup ─────────────────────────

  /**
   * F1 §4.3 — owner-only hard delete: every DB row plus the uploaded file
   * and extracted figures on disk. Learner-facing dependents (forks,
   * purchases, classrooms, certificates) block deletion instead of
   * cascading into other people's data.
   */
  async deleteCourse(userId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ownerId: userId },
      select: { id: true },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    return this.destroyCourse(courseId);
  }

  async destroyCourse(courseId: string) {
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
    // Storage-backed: works for local disk and S3 (virtual-hosted keys).
    for (const doc of documents) {
      if (doc.fileUrl) {
        await this.storage.deleteKey(doc.fileUrl).catch(() => undefined);
      }
    }
    await this.storage.deletePrefix(`assets/${courseId}`).catch(() => undefined);

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
}
