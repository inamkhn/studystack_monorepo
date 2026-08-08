import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AiService } from "../ai/ai.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F10 — In-Tutorial Q&A service.
 *
 * Handles Q&A message history retrieval and question answering with
 * semantic-cache deduplication. The cache check queries `qna_messages`
 * across all students on the same subtopic — if a sufficiently similar
 * question was already answered, that answer is reused instead of
 * calling the LLM again.
 *
 * Currently the semantic-cache step is a structural placeholder:
 * embedding generation and pgvector similarity queries land with the
 * AiModule pipeline (build-order step 5). Until then, every question
 * triggers a fresh answer call — which itself is a stub that throws
 * `NotImplementedException`.
 */
@Injectable()
export class QnaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Returns the authenticated student's own Q&A message history for
   * this subtopic, ordered oldest-first.
   */
  async getHistory(
    userId: string,
    subtopicId: string,
  ): Promise<{ id: string; question: string; answer: string; timestamp: Date }[]> {
    // Validate subtopic exists.
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      select: { id: true },
    });
    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    return this.prisma.qnaMessage.findMany({
      where: { subtopicId, studentId: userId },
      select: { id: true, question: true, answer: true, timestamp: true },
      orderBy: { timestamp: "asc" },
    });
  }

  /**
   * Accepts a student's question and returns an answer grounded in this
   * subtopic's tutorial content.
   *
   * Before generating, checks for a prior answered question on the same
   * `subtopic_id` with high embedding similarity to the incoming question,
   * across all students — on a hit, returns the cached answer.
   */
  async askQuestion(
    userId: string,
    subtopicId: string,
    question: string,
  ): Promise<{ id: string; question: string; answer: string; timestamp: Date; cached: boolean }> {
    // Validate subtopic exists.
    const subtopic = await this.prisma.subtopic.findUnique({
      where: { id: subtopicId },
      select: { id: true },
    });
    if (!subtopic) {
      throw new NotFoundException("Subtopic not found");
    }

    // ── semantic cache check ──────────────────────────────────────────
    // TODO(F10): once the AiModule pipeline lands (build-order step 5),
    // generate an embedding for `question`, then query:
    //
    //   SELECT id, question, answer, timestamp,
    //          1 - (embedding <=> $incoming_embedding) AS similarity
    //   FROM qna_messages
    //   WHERE "subtopicId" = $subtopicId
    //   ORDER BY embedding <=> $incoming_embedding
    //   LIMIT 1;
    //
    // If similarity > CACHE_THRESHOLD (e.g. 0.92), return the cached
    // answer with `cached: true` instead of calling the LLM.
    const cached = await this.semanticCacheCheck(subtopicId, question);
    if (cached) {
      return { ...cached, cached: true };
    }

    // ── cache miss → generate ─────────────────────────────────────────
    // Fetch the subtopic's tutorial explanation as grounding context.
    // We use the "neutral" style bucket at the course's level — this is
    // the default tutorial row that exists for every subtopic.
    const tutorial = await this.prisma.tutorialContent.findFirst({
      where: { subtopicId, styleBucket: "neutral" },
      select: { explanation: true },
      orderBy: { generatedAt: "desc" },
    });

    if (!tutorial) {
      throw new BadRequestException(
        "Subtopic tutorial not yet generated. Open the lesson first to enable Q&A.",
      );
    }

    // explanation is Json in the schema — always an object at runtime.
    const tutorialExplanation = JSON.stringify(tutorial.explanation);

    const answer = await this.ai.answerQnaQuestion({
      subtopicId,
      question,
      tutorialExplanation,
    });

    // ── persist ───────────────────────────────────────────────────────
    const row = await this.prisma.qnaMessage.create({
      data: {
        subtopicId,
        studentId: userId,
        question,
        answer,
      },
    });

    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      timestamp: row.timestamp,
      cached: false,
    };
  }

  /**
   * Semantic-cache lookup: checks whether a near-identical question was
   * already answered on this subtopic (across all students).
   *
   * Returns the cached row on a hit, or `null` on a miss.
   *
   * TODO(F10): wire embedding generation + pgvector similarity once the
   * AiModule pipeline lands. Until then, always returns `null` (miss).
   */
  private async semanticCacheCheck(
    _subtopicId: string,
    _question: string,
  ): Promise<{ id: string; question: string; answer: string; timestamp: Date } | null> {
    // Stub — embedding generation not yet available (AiModule build step 5).
    // When wired, this method will:
    //   1. Generate an embedding for `question` via the embedding model.
    //   2. Query qna_messages with pgvector cosine similarity, scoped to subtopicId.
    //   3. Return the top match if above the similarity threshold.
    return null;
  }
}
