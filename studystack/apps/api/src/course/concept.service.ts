import {
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class ConceptService {
  constructor(private readonly prisma: PrismaService) {}

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
