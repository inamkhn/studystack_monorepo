import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F19 — Teacher / Classroom Mode.
 *
 * Teachers create classrooms tied to existing courses and invite students
 * via a generated class code. Students join with the code, which creates
 * both a `course_forks` row (same F14 fork-on-"taking" mechanism) and a
 * `classroom_students` membership. The teacher dashboard surfaces
 * aggregated, anonymized mastery/quiz data per concept.
 */
@Injectable()
export class ClassroomService {
  constructor(private readonly prisma: PrismaService) {}

  // ── create classroom ──────────────────────────────────────────────────

  async createClassroom(
    teacherId: string,
    dto: { courseId: string; consentOnFile: boolean; consentDocumentUrl?: string },
  ) {
    // F19: classroom creation requires consent attestation at creation time.
    if (!dto.consentOnFile && !dto.consentDocumentUrl) {
      throw new BadRequestException(
        "Consent attestation is required — set consentOnFile or provide a consentDocumentUrl",
      );
    }

    // Verify the teacher owns the course.
    const course = await this.prisma.course.findFirst({
      where: { id: dto.courseId, ownerId: teacherId },
      select: { id: true, status: true },
    });

    if (!course) {
      throw new NotFoundException(
        "Course not found or you do not own it",
      );
    }

    if (course.status !== "ready") {
      throw new BadRequestException(
        "Course is not yet ready — wait for structuring to complete before creating a classroom",
      );
    }

    // Generate a unique invite code.
    const inviteCode = generateInviteCode();

    try {
      return await this.prisma.classroom.create({
        data: {
          teacherId,
          courseId: dto.courseId,
          consentOnFile: dto.consentOnFile,
          consentDocumentUrl: dto.consentDocumentUrl ?? null,
          inviteCode,
        },
        select: {
          id: true,
          courseId: true,
          inviteCode: true,
          consentOnFile: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Invite-code collision — extremely rare with 6-char unambiguous
        // codes (~32^6 = 1B combinations), but regenerate and retry.
        const retryCode = generateInviteCode();
        return this.prisma.classroom.create({
          data: {
            teacherId,
            courseId: dto.courseId,
            consentOnFile: dto.consentOnFile,
            consentDocumentUrl: dto.consentDocumentUrl ?? null,
            inviteCode: retryCode,
          },
          select: {
            id: true,
            courseId: true,
            inviteCode: true,
            consentOnFile: true,
          },
        });
      }
      throw error;
    }
  }

  // ── generate / refresh invite code ────────────────────────────────────

  async generateInviteCode(teacherId: string, classroomId: string) {
    await this.getClassroomOrThrow(classroomId, teacherId);

    const inviteCode = generateInviteCode();

    try {
      return await this.prisma.classroom.update({
        where: { id: classroomId },
        data: { inviteCode },
        select: { id: true, inviteCode: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const retryCode = generateInviteCode();
        return this.prisma.classroom.update({
          where: { id: classroomId },
          data: { inviteCode: retryCode },
          select: { id: true, inviteCode: true },
        });
      }
      throw error;
    }
  }

  // ── join classroom via invite code ────────────────────────────────────

  async joinClassroom(studentId: string, classroomId: string, inviteCode: string) {
    // Look up the classroom by id + invite code to validate the code.
    const classroom = await this.prisma.classroom.findFirst({
      where: { id: classroomId, inviteCode },
      select: {
        id: true,
        courseId: true,
        students: {
          where: { studentId },
          select: { studentId: true },
        },
      },
    });

    if (!classroom) {
      throw new BadRequestException(
        "Invalid invite code or classroom not found",
      );
    }

    // Already enrolled — idempotent.
    if (classroom.students.length > 0) {
      return { classroomId: classroom.id, alreadyEnrolled: true };
    }

    // Create the fork first (F14 fork-on-"taking" mechanism).
    const fork = await this.prisma.courseFork.upsert({
      where: {
        originalCourseId_studentId: {
          originalCourseId: classroom.courseId,
          studentId,
        },
      },
      create: {
        originalCourseId: classroom.courseId,
        studentId,
      },
      update: {},
      select: { id: true },
    });

    // Create the classroom-student membership (upsert — idempotent).
    await this.prisma.classroomStudent.upsert({
      where: {
        classroomId_studentId: {
          classroomId: classroom.id,
          studentId,
        },
      },
      create: {
        classroomId: classroom.id,
        studentId,
        forkId: fork.id,
      },
      update: { forkId: fork.id },
    });

    // F19: set age_bracket = minor_school_consented only if the account
    // is brand-new (unknown) — never downgrade an already-adult account.
    await this.prisma.user.updateMany({
      where: { id: studentId, ageBracket: "unknown" },
      data: { ageBracket: "minor_school_consented" },
    });

    return {
      classroomId: classroom.id,
      forkId: fork.id,
    };
  }

  // ── roster ────────────────────────────────────────────────────────────

  async getRoster(teacherId: string, classroomId: string) {
    await this.getClassroomOrThrow(classroomId, teacherId);

    const students = await this.prisma.classroomStudent.findMany({
      where: { classroomId },
      select: {
        student: { select: { id: true, name: true, ageBracket: true } },
        joinedAt: true,
      },
      orderBy: { joinedAt: "asc" },
    });

    return {
      classroomId,
      studentCount: students.length,
      students: students.map((s) => ({
        id: s.student.id,
        name: s.student.name,
        ageBracket: s.student.ageBracket,
        joinedAt: s.joinedAt,
      })),
    };
  }

  // ── dashboard ─────────────────────────────────────────────────────────

  async getDashboard(teacherId: string, classroomId: string) {
    const classroom = await this.prisma.classroom.findUnique({
      where: { id: classroomId },
      select: {
        id: true,
        teacherId: true,
        courseId: true,
        students: {
          select: { studentId: true, forkId: true },
        },
      },
    });

    if (!classroom || classroom.teacherId !== teacherId) {
      throw new NotFoundException("Classroom not found");
    }

    const studentIds = classroom.students.map((s) => s.studentId);
    const forkIds = classroom.students
      .map((s) => s.forkId)
      .filter((f): f is string => f !== null);

    if (studentIds.length === 0) {
      return { classroomId, conceptBreakdown: [], studentCount: 0 };
    }

    // Get all concepts reachable through the classroom's course.
    const concepts = await this.prisma.subtopicConcept.findMany({
      where: { subtopic: { module: { courseId: classroom.courseId } } },
      select: { conceptId: true, concept: { select: { canonicalName: true } } },
      distinct: ["conceptId"],
    });

    const conceptIds = concepts.map((c) => c.conceptId);

    if (conceptIds.length === 0) {
      return { classroomId, conceptBreakdown: [], studentCount: studentIds.length };
    }

    // Mastery: aggregate scores for the classroom's students over the
    // course's concepts (mastery_scores is global per student+concept,
    // so we scope by concept set and student set, not by fork).
    const masteryScores = await this.prisma.masteryScore.findMany({
      where: {
        studentId: { in: studentIds },
        conceptId: { in: conceptIds },
      },
      select: { conceptId: true, score: true },
    });

    // Quiz attempts: join via fork_id (classroom_students.fork_id).
    const quizAttempts =
      forkIds.length > 0
        ? await this.prisma.quizAttempt.findMany({
            where: { forkId: { in: forkIds } },
            select: { conceptId: true, correct: true },
          })
        : [];

    // Build per-concept aggregated view.
    const conceptBreakdown = concepts.map(({ conceptId, concept }) => {
      const conceptMastery = masteryScores.filter(
        (m) => m.conceptId === conceptId,
      );
      const conceptQuizzes = quizAttempts.filter(
        (q) => q.conceptId === conceptId,
      );

      const avgMastery =
        conceptMastery.length > 0
          ? conceptMastery.reduce((sum, m) => sum + m.score, 0) /
            conceptMastery.length
          : null;

      const quizTotal = conceptQuizzes.length;
      const quizCorrect = conceptQuizzes.filter((q) => q.correct).length;

      return {
        conceptId,
        canonicalName: concept.canonicalName,
        studentsWithMastery: conceptMastery.length,
        avgMastery: avgMastery !== null ? Math.round(avgMastery * 100) : null,
        quizAttempts: quizTotal,
        quizAccuracy:
          quizTotal > 0 ? Math.round((quizCorrect / quizTotal) * 100) : null,
      };
    });

    return {
      classroomId,
      studentCount: studentIds.length,
      conceptBreakdown,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async getClassroomOrThrow(classroomId: string, teacherId: string) {
    const classroom = await this.prisma.classroom.findUnique({
      where: { id: classroomId },
      select: { id: true, teacherId: true, inviteCode: true },
    });

    if (!classroom || classroom.teacherId !== teacherId) {
      throw new NotFoundException("Classroom not found");
    }

    return classroom;
  }
}

// ── internal helpers ───────────────────────────────────────────────────

/**
 * Unambiguous uppercase alphanumeric character set — excludes O/0/I/1
 * to avoid human transcription errors on printed class codes.
 */
const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Generates a 6-character class invite code from a fixed unambiguous set.
 * Each character is deterministically derived from a random byte, giving
 * ~32^6 ≈ 1 billion possible codes — sufficient to make collisions
 * astronomically unlikely in a classroom-sized dataset.
 */
function generateInviteCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += INVITE_CHARS[bytes[i] % INVITE_CHARS.length];
  }
  return code;
}
