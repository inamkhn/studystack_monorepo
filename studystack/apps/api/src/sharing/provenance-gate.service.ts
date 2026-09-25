import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F14 copyright/provenance gate — shared internal logic reused by the
 * publish flow (here) and MarketplaceService.submitForReview (F17).
 */
@Injectable()
export class ProvenanceGateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs the copyright/provenance gate for a course.
   *
   * Full scan if `publish_gate_checked_at` is null, incremental (rows
   * generated since the last check) otherwise.
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
}
