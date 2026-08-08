import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from "@nestjs/common";
import type { Goal, Level } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F17 — Course Marketplace.
 *
 * Creators submit courses for review; admins approve/reject; buyers
 * purchase via Stripe (stubbed) and receive a course fork for tracking.
 * The provenance gate from F14 is reused — shared internal logic, not
 * an HTTP round-trip.
 */
@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseService: CourseService,
  ) {}

  // ── submit for review ─────────────────────────────────────────────────

  async submitForReview(userId: string, courseId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, ageBracket: true },
    });

    if (!user || user.role !== "creator") {
      throw new ForbiddenException(
        "Only creator accounts can submit courses to the marketplace",
      );
    }

    if (user.ageBracket !== "adult") {
      throw new ForbiddenException(
        "Minors cannot list paid courses on the marketplace",
      );
    }

    const course = await this.courseService.requireOwnedCourse(
      userId,
      courseId,
    );

    if (course.status !== "ready") {
      throw new BadRequestException(
        "Course is not yet ready — wait for ingestion and structuring to complete",
      );
    }

    if (course.price == null || course.price <= 0) {
      throw new BadRequestException(
        "A positive price is required for marketplace submission",
      );
    }

    // Reuse the same provenance gate as publish — shared internal logic.
    const gate = await this.courseService.runProvenanceGate(courseId);
    if (!gate.passed) {
      throw new BadRequestException(
        `Cannot submit to marketplace: copyright is unclear for ${gate.offendingSubtopicIds.length} subtopic(s). ` +
          "Resolve license status on uploaded source material first.",
      );
    }

    // Check for an existing pending/approved submission — idempotent.
    // Wrapped in an interactive transaction with a post-insert race guard
    // (same pattern as practice-problem generation in F12). Without a
    // partial unique index (not expressible in Prisma), two concurrent
    // submissions for the same course can both pass the findFirst check;
    // the P2002 catch + findFirstOrThrow fallback on the recheck handles
    // the loser.
    const now = new Date();
    const slaDueAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.marketplaceReviewQueue.findFirst({
          where: { courseId, status: { in: ["pending", "approved"] } },
          select: {
            id: true,
            status: true,
            submittedAt: true,
            slaDueAt: true,
          },
        });

        if (existing) {
          return existing;
        }

        return tx.marketplaceReviewQueue.create({
          data: {
            courseId,
            creatorId: userId,
            slaDueAt,
            copyrightChecklistPassed: false,
          },
          select: {
            id: true,
            status: true,
            submittedAt: true,
            slaDueAt: true,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Concurrent submission — another request created the review row
        // between our findFirst check and this create.
        return this.prisma.marketplaceReviewQueue.findFirstOrThrow({
          where: { courseId, status: { in: ["pending", "approved"] } },
          select: {
            id: true,
            status: true,
            submittedAt: true,
            slaDueAt: true,
          },
        });
      }
      throw error;
    }
  }

  // ── browse marketplace ─────────────────────────────────────────────────

  async browseMarketplace(filters?: {
    subject?: string;
    level?: Level;
    goal?: Goal;
  }) {
    const where: Record<string, unknown> = {
      marketplaceReviews: { some: { status: "approved" } },
    };

    if (filters?.subject) {
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
        price: true,
        owner: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  }

  // ── purchase (payment stubbed, fork fully wired) ──────────────────────

  async purchaseCourse(userId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        price: true,
        ownerId: true,
        stripeProductId: true,
      },
    });

    if (!course) {
      throw new NotFoundException("Course not found");
    }

    if (course.ownerId === userId) {
      throw new BadRequestException("You cannot purchase your own course");
    }

    if (course.price == null || course.price <= 0) {
      throw new BadRequestException("Course is not for sale");
    }

    // Verify the course is approved on the marketplace.
    const approved = await this.prisma.marketplaceReviewQueue.findFirst({
      where: { courseId, status: "approved" },
      select: { id: true },
    });

    if (!approved) {
      throw new BadRequestException(
        "This course is not currently available for purchase",
      );
    }

    // Check for an existing purchase — idempotent.
    const existingPurchase = await this.prisma.purchase.findFirst({
      where: { courseId, buyerId: userId },
      select: { id: true, amount: true, timestamp: true },
    });

    if (existingPurchase) {
      // Ensure the fork exists (defensive — it should have been created on
      // first purchase, but a migration or partial failure could leave a
      // purchase without a fork).
      const fork = await this.prisma.courseFork.upsert({
        where: {
          originalCourseId_studentId: {
            originalCourseId: courseId,
            studentId: userId,
          },
        },
        create: { originalCourseId: courseId, studentId: userId },
        update: {},
        select: { id: true },
      });

      return { ...existingPurchase, forkId: fork.id };
    }

    // TODO(F17): Stripe Checkout — redirect to Stripe, create PaymentIntent,
    // confirm with webhook. Until integrated, treat this as a free purchase.
    // The data model is fully populated: Purchase + CourseFork are created
    // atomically, so when Stripe lands only the payment-authorization step
    // needs wiring.
    throw new NotImplementedException(
      "Payment processing not yet available — Stripe integration lands in build order step 7. " +
        "The purchase and fork data model is fully specified; only the checkout flow is stubbed.",
    );
  }

  // ── creator payout dashboard ───────────────────────────────────────────

  async getPayouts(userId: string) {
    const courses = await this.prisma.course.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        title: true,
        price: true,
        creatorPayoutPct: true,
        purchases: {
          select: { amount: true, timestamp: true },
        },
      },
    });

    const payouts = courses.map((course) => {
      const revenue = course.purchases.reduce(
        (sum, p) => sum + p.amount,
        0,
      );
      const payoutPct = course.creatorPayoutPct ?? 70;
      const creatorCut = (revenue * payoutPct) / 100;

      return {
        courseId: course.id,
        courseTitle: course.title,
        price: course.price,
        totalPurchases: course.purchases.length,
        totalRevenue: revenue,
        payoutPct,
        creatorCut,
      };
    });

    const grandTotal = payouts.reduce((sum, p) => sum + p.creatorCut, 0);

    return {
      creatorId: userId,
      courses: payouts,
      grandTotal,
    };
  }

  // ── admin: list pending review queue ───────────────────────────────────

  async listReviewQueue() {
    return this.prisma.marketplaceReviewQueue.findMany({
      where: { status: "pending" },
      select: {
        id: true,
        submittedAt: true,
        slaDueAt: true,
        course: {
          select: {
            id: true,
            title: true,
            topic: true,
            price: true,
            owner: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { submittedAt: "asc" },
    });
  }

  // ── admin: approve ─────────────────────────────────────────────────────

  async approveSubmission(reviewId: string) {
    const review = await this.prisma.marketplaceReviewQueue.findUnique({
      where: { id: reviewId },
      select: { id: true, status: true },
    });

    if (!review) {
      throw new NotFoundException("Marketplace review not found");
    }

    if (review.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a submission with status "${review.status}"`,
      );
    }

    return this.prisma.marketplaceReviewQueue.update({
      where: { id: reviewId },
      data: {
        status: "approved",
        copyrightChecklistPassed: true,
      },
      select: { id: true, status: true, courseId: true },
    });
  }

  // ── admin: reject ──────────────────────────────────────────────────────

  async rejectSubmission(reviewId: string) {
    const review = await this.prisma.marketplaceReviewQueue.findUnique({
      where: { id: reviewId },
      select: { id: true, status: true },
    });

    if (!review) {
      throw new NotFoundException("Marketplace review not found");
    }

    if (review.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a submission with status "${review.status}"`,
      );
    }

    return this.prisma.marketplaceReviewQueue.update({
      where: { id: reviewId },
      data: { status: "rejected" },
      select: { id: true, status: true, courseId: true },
    });
  }
}
