import { Injectable } from "@nestjs/common";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

// ═════════════════════════════════════════════════════════════════════════
// F11 mastery-map color thresholds — documented once here.
// These mirror the MasteryService score range: 0.05 floor, 1.0 ceiling.
// ═════════════════════════════════════════════════════════════════════════
const WEAK_THRESHOLD = 0.4;
const MASTERED_THRESHOLD = 0.7;

type MasteryStatus = "not_started" | "weak" | "moderate" | "mastered";

interface ActionHint {
  type: "tutorial" | "review";
  subtopicId?: string;
  conceptId?: string;
}

export interface MasteryMapNode {
  type: "course" | "module" | "subtopic";
  id: string;
  title: string;
  order: number;
  masteryStatus: MasteryStatus;
  weakConceptCount: number;
  notStartedConceptCount: number;
  totalConceptCount: number;
  action?: ActionHint;
  children?: MasteryMapNode[];
}

/**
 * F11 — builds the visual mastery-map tree for a course by joining
 * `modules`/`subtopics`/`subtopic_concepts` with the student's
 * `mastery_scores` and `subtopic_completions`.
 *
 * Pure derived read — zero new tables.
 */
@Injectable()
export class MasteryMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseService: CourseService,
  ) {}

  async buildMap(userId: string, courseId: string): Promise<MasteryMapNode> {
    await this.courseService.assertCourseAccess(userId, courseId);

    // ── load course metadata ─────────────────────────────────────────
    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { id: true, title: true },
    });

    // ── load full course structure ────────────────────────────────────
    const modules = await this.prisma.module.findMany({
      where: { courseId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        title: true,
        order: true,
        subtopics: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            title: true,
            order: true,
            subtopicConcepts: {
              select: { conceptId: true },
            },
          },
        },
      },
    });

    // ── collect all concept IDs across the course ─────────────────────
    const allConceptIds = new Set<string>();
    for (const mod of modules) {
      for (const st of mod.subtopics) {
        for (const sc of st.subtopicConcepts) {
          allConceptIds.add(sc.conceptId);
        }
      }
    }

    // ── load mastery + completions in two bulk queries ────────────────
    const [scores, completions] = await Promise.all([
      this.prisma.masteryScore.findMany({
        where: {
          studentId: userId,
          conceptId: { in: [...allConceptIds] },
        },
        select: {
          conceptId: true,
          score: true,
          nextReviewAt: true,
          concept: { select: { canonicalName: true } },
        },
      }),
      this.prisma.subtopicCompletion.findMany({
        where: {
          studentId: userId,
          subtopicId: {
            in: modules.flatMap((m) => m.subtopics.map((s) => s.id)),
          },
        },
        select: { subtopicId: true },
      }),
    ]);

    const scoreByConcept = new Map(
      scores.map((s) => [s.conceptId, { conceptId: s.conceptId, score: s.score, nextReviewAt: s.nextReviewAt, name: s.concept.canonicalName }]),
    );
    const completedSubtopicIds = new Set(
      completions.map((c) => c.subtopicId),
    );

    // ── build tree ────────────────────────────────────────────────────
    const now = new Date();

    const moduleNodes: MasteryMapNode[] = modules.map((mod) => {
      const subtopicNodes: MasteryMapNode[] = mod.subtopics.map((st) => {
        const conceptIds = st.subtopicConcepts.map((sc) => sc.conceptId);
        const conceptScores = conceptIds
          .map((cid) => scoreByConcept.get(cid))
          .filter(Boolean) as { conceptId: string; score: number; nextReviewAt: Date; name: string }[];

        const total = conceptIds.length;
        const scored = conceptScores.length;
        const notStarted = total - scored;
        const weak = conceptScores.filter((cs) => cs.score < WEAK_THRESHOLD).length;

        // Aggregate: worst concept score across this subtopic.
        const worstScore =
          scored > 0
            ? Math.min(...conceptScores.map((cs) => cs.score))
            : null;

        // Unscored concepts render as "not_started" per spec — a subtopic
        // with any unscored concept cannot be considered "mastered."
        const rawStatus: MasteryStatus =
          total === 0
            ? "not_started"
            : worstScore === null
              ? "not_started"
              : worstScore < WEAK_THRESHOLD
                ? "weak"
                : worstScore < MASTERED_THRESHOLD
                  ? "moderate"
                  : "mastered";

        const masteryStatus: MasteryStatus =
          notStarted > 0 && rawStatus === "mastered"
            ? "moderate"
            : rawStatus;

        // Routing hint — per-spec: client navigates without a second round-trip.
        let action: ActionHint | undefined;
        const isCompleted = completedSubtopicIds.has(st.id);

        if (!isCompleted) {
          // Not yet finished → go back to the subtopic tutorial.
          action = { type: "tutorial", subtopicId: st.id };
        } else {
          // Completed once → if any concept is due or weak, point to review.
          const dueConcept = conceptScores.find(
            (cs) => cs.nextReviewAt <= now || cs.score < WEAK_THRESHOLD,
          );
          if (dueConcept) {
            action = {
              type: "review",
              subtopicId: st.id,
              conceptId: dueConcept.conceptId,
            };
          }
          // If completed and all concepts are healthy → no action needed
          // (client may show "mastered" badge, tap to revisit tutorial).
        }

        return {
          type: "subtopic",
          id: st.id,
          title: st.title,
          order: st.order,
          masteryStatus,
          weakConceptCount: weak,
          notStartedConceptCount: notStarted,
          totalConceptCount: total,
          action,
        };
      });

      // Module aggregate: worst subtopic.
      const moduleMastery: MasteryStatus = subtopicNodes.length === 0
        ? "not_started"
        : subtopicNodes.some((s) => s.masteryStatus === "not_started")
          ? "not_started"
          : subtopicNodes.some((s) => s.masteryStatus === "weak")
            ? "weak"
            : subtopicNodes.some((s) => s.masteryStatus === "moderate")
              ? "moderate"
              : "mastered";

      return {
        type: "module",
        id: mod.id,
        title: mod.title,
        order: mod.order,
        masteryStatus: moduleMastery,
        weakConceptCount: subtopicNodes.reduce((sum, s) => sum + s.weakConceptCount, 0),
        notStartedConceptCount: subtopicNodes.reduce((sum, s) => sum + s.notStartedConceptCount, 0),
        totalConceptCount: subtopicNodes.reduce((sum, s) => sum + s.totalConceptCount, 0),
        children: subtopicNodes,
      };
    });

    // Course aggregate: worst module.
    const courseMastery: MasteryStatus = moduleNodes.length === 0
      ? "not_started"
      : moduleNodes.some((m) => m.masteryStatus === "not_started")
        ? "not_started"
        : moduleNodes.some((m) => m.masteryStatus === "weak")
          ? "weak"
          : moduleNodes.some((m) => m.masteryStatus === "moderate")
            ? "moderate"
            : "mastered";

    return {
      type: "course",
      id: course.id,
      title: course.title,
      order: 0,
      masteryStatus: courseMastery,
      weakConceptCount: moduleNodes.reduce((sum, m) => sum + m.weakConceptCount, 0),
      notStartedConceptCount: moduleNodes.reduce((sum, m) => sum + m.notStartedConceptCount, 0),
      totalConceptCount: moduleNodes.reduce((sum, m) => sum + m.totalConceptCount, 0),
      children: moduleNodes,
    };
  }
}
