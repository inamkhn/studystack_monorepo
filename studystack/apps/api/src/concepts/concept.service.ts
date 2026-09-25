import { Injectable, NotFoundException } from "@nestjs/common";
import { CourseService } from "../course/course.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class ConceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseService: CourseService,
  ) {}

  // ── F4 expanded: single concept ────────────────────────────────────────

  async getConcept(id: string) {
    const concept = await this.prisma.concept.findUnique({ where: { id } });

    if (!concept) {
      throw new NotFoundException("Concept not found");
    }

    return concept;
  }

  // ── F4 expanded: name/alias search ─────────────────────────────────────

  async searchConcepts(search: string) {
    // Embedding similarity search lands with AiModule — name/alias text
    // search is the endpoint contract today.
    if (!search.trim()) {
      return this.prisma.concept.findMany({
        orderBy: { canonicalName: "asc" },
        take: 50,
      });
    }

    return this.prisma.concept.findMany({
      where: {
        OR: [
          { canonicalName: { contains: search, mode: "insensitive" } },
          { aliases: { has: search } },
        ],
      },
      orderBy: { canonicalName: "asc" },
      take: 50,
    });
  }

  // ── F15: cross-course concept links ────────────────────────────────────

  async getLinkedCourses(userId: string, conceptId: string) {
    await this.getConcept(conceptId); // 404 if the concept doesn't exist

    return this.prisma.course.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { courseForks: { some: { studentId: userId } } },
        ],
        modules: {
          some: {
            subtopics: {
              some: { subtopicConcepts: { some: { conceptId } } },
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        sourceType: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  // ── F15: concept links for one subtopic ────────────────────────────────

  async getConceptLinks(userId: string, courseId: string, subtopicId: string) {
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      include: { module: true },
    });

    if (!subtopic || subtopic.module.courseId !== courseId) {
      throw new NotFoundException("Subtopic not found in course");
    }

    await this.courseService.assertCourseAccess(userId, courseId);

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

  // ── F15: student's full concept-mastery graph ──────────────────────────

  async getConceptGraph(userId: string) {
    const scores = await this.prisma.masteryScore.findMany({
      where: { studentId: userId },
      include: { concept: true },
      orderBy: { lastReviewedAt: "desc" },
    });

    return scores.map((score) => ({
      conceptId: score.conceptId,
      canonicalName: score.concept.canonicalName,
      subjectArea: score.concept.subjectArea,
      score: score.score,
      lastReviewedAt: score.lastReviewedAt,
      nextReviewAt: score.nextReviewAt,
    }));
  }
}
