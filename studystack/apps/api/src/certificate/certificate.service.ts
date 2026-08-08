import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CertificateCourseType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F16 — Verified Completion / Shareable Certificate.
 *
 * Eligibility is derived from `subtopic_completions` (all subtopics done)
 * + a final-project submission. Issuance is idempotent per student+course
 * (enforced by the `@@unique([studentId, courseId])` constraint).
 * Public verification reads by `verificationSlug` without authentication.
 */
@Injectable()
export class CertificateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns whether the authenticated student has completed everything
   * required for a certificate — all subtopics marked complete + a final
   * project submission for this course.
   */
  async checkEligibility(
    userId: string,
    courseId: string,
  ): Promise<{
    eligible: boolean;
    completedSubtopics: number;
    totalSubtopics: number;
    finalProjectDone: boolean;
    missingSubtopicIds: string[];
  }> {
    // Load every subtopic in the course (via modules).
    const subtopics = await this.prisma.subtopic.findMany({
      where: { module: { courseId } },
      select: { id: true, title: true },
    });
    const subtopicIds = subtopics.map((s) => s.id);
    const totalSubtopics = subtopicIds.length;

    if (totalSubtopics === 0) {
      return {
        eligible: false,
        completedSubtopics: 0,
        totalSubtopics: 0,
        finalProjectDone: false,
        missingSubtopicIds: [],
      };
    }

    // Count completions for this student across course subtopics.
    const completions = await this.prisma.subtopicCompletion.findMany({
      where: { studentId: userId, subtopicId: { in: subtopicIds } },
      select: { subtopicId: true },
    });
    const completedIds = new Set(completions.map((c) => c.subtopicId));
    const completedSubtopics = completedIds.size;
    const missingSubtopicIds = subtopicIds.filter((id) => !completedIds.has(id));

    // Final project: find a quiz_attempt with type=final_project whose
    // module belongs to this course.
    const finalProjectAttempt = await this.prisma.quizAttempt.findFirst({
      where: {
        studentId: userId,
        type: "final_project",
        module: { courseId },
      },
      select: { id: true },
    });

    const eligible =
      completedSubtopics === totalSubtopics && !!finalProjectAttempt;

    return {
      eligible,
      completedSubtopics,
      totalSubtopics,
      finalProjectDone: !!finalProjectAttempt,
      missingSubtopicIds: eligible ? [] : missingSubtopicIds,
    };
  }

  /**
   * Issues a certificate for the student on this course.
   *
   * Idempotent — re-calling on an already-issued certificate returns the
   * existing record (enforced by the unique constraint on student+course).
   *
   * `courseType` is always `ai_generated` for now — every course today is
   * AI-generated; `instructor_verified` is future-proofed in the schema
   * for Marketplace courses (F17) that aren't built yet.
   */
  async issueCertificate(
    userId: string,
    courseId: string,
  ): Promise<{
    id: string;
    studentName: string;
    courseTitle: string;
    issuedAt: Date;
    verificationSlug: string;
    courseType: CertificateCourseType;
  }> {
    // Guard: must be eligible before issuing.
    const eligibility = await this.checkEligibility(userId, courseId);
    if (!eligibility.eligible) {
      throw new BadRequestException(
        "Course not yet completed — all subtopics and the final project must be finished.",
      );
    }

    // Check for an existing certificate (idempotent).
    const existing = await this.prisma.certificate.findFirst({
      where: { studentId: userId, courseId },
      select: {
        id: true,
        issuedAt: true,
        verificationSlug: true,
        courseType: true,
        student: { select: { name: true } },
        course: { select: { title: true } },
      },
    });
    if (existing) {
      return {
        id: existing.id,
        studentName: existing.student.name,
        courseTitle: existing.course.title,
        issuedAt: existing.issuedAt,
        verificationSlug: existing.verificationSlug,
        courseType: existing.courseType,
      };
    }

    // Generate a unique verification slug.
    const verificationSlug = randomBytes(12).toString("base64url");

    const courseType: CertificateCourseType = "ai_generated";

    try {
      const cert = await this.prisma.certificate.create({
        data: {
          studentId: userId,
          courseId,
          verificationSlug,
          courseType,
        },
        select: {
          id: true,
          issuedAt: true,
          verificationSlug: true,
          courseType: true,
          student: { select: { name: true } },
          course: { select: { title: true } },
        },
      });

      return {
        id: cert.id,
        studentName: cert.student.name,
        courseTitle: cert.course.title,
        issuedAt: cert.issuedAt,
        verificationSlug: cert.verificationSlug,
        courseType: cert.courseType,
      };
    } catch (error) {
      // Concurrent issuance — another request created the certificate
      // between our findFirst check and this create. Return the winner's
      // row instead of failing.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.prisma.certificate.findFirstOrThrow({
          where: { studentId: userId, courseId },
          select: {
            id: true,
            issuedAt: true,
            verificationSlug: true,
            courseType: true,
            student: { select: { name: true } },
            course: { select: { title: true } },
          },
        });
        return {
          id: winner.id,
          studentName: winner.student.name,
          courseTitle: winner.course.title,
          issuedAt: winner.issuedAt,
          verificationSlug: winner.verificationSlug,
          courseType: winner.courseType,
        };
      }
      throw error;
    }
  }

  /**
   * Public, unauthenticated lookup by verification slug.
   *
   * Returns the certificate details for anyone who clicks through from a
   * shared link. No authentication required.
   */
  async getBySlug(verificationSlug: string): Promise<{
    studentName: string;
    courseTitle: string;
    courseType: CertificateCourseType;
    issuedAt: Date;
    level: string | null;
  }> {
    const cert = await this.prisma.certificate.findUnique({
      where: { verificationSlug },
      select: {
        issuedAt: true,
        courseType: true,
        student: { select: { name: true } },
        course: { select: { title: true, level: true } },
      },
    });

    if (!cert) {
      throw new NotFoundException("Certificate not found");
    }

    return {
      studentName: cert.student.name,
      courseTitle: cert.course.title,
      courseType: cert.courseType,
      issuedAt: cert.issuedAt,
      level: cert.course.level,
    };
  }
}
