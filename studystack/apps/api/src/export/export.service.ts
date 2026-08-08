import { Injectable, NotFoundException, NotImplementedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * F13 — Export to External Tools.
 *
 * Reads `tutorial_content` rows for a module and transforms them into
 * export formats. Three surfaces: Anki flashcards, PDF document, and
 * Notion page creation.
 *
 * Currently scaffolded — the read/transform logic is in place, but
 * actual file rendering and third-party API calls are stubbed:
 *
 * - Anki: needs a `flashcards` table or flashcard field on
 *   `tutorial_content` before the endpoint has anything to read.
 * - PDF:  needs a PDF library (puppeteer / jspdf / pdfkit) — none
 *   are in `package.json` yet.
 * - Notion: needs a `notion_connections` table + OAuth flow before
 *   the endpoint can retrieve credentials or call Notion's API.
 */
@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Anki deck export — blocked until flashcard storage is decided.
   *
   * The features doc contradicted itself on flashcard storage ("No new
   * storage" vs "dedicated `flashcards` table"). Neither option has been
   * implemented — `TutorialContent` has no flashcard field, and there is
   * no `flashcards` table. Until this is resolved, Anki export has
   * nothing to read.
   */
  async exportAnki(_moduleId: string): Promise<never> {
    throw new NotImplementedException(
      "Anki export not yet available — flashcard storage is undecided. " +
        "Needs either a `flashcards` table or a flashcard field on `tutorial_content`.",
    );
  }

  /**
   * PDF export — read logic is wired, rendering is stubbed.
   *
   * Fetches every `tutorial_content` row for the module's subtopics
   * (neutral style bucket, newest first), transforms into a structured
   * document shape, then passes to the PDF renderer.
   */
  async exportPdf(
    moduleId: string,
  ): Promise<never> {
    const mod = await this.prisma.module.findUnique({
      where: { id: moduleId },
      select: { id: true, title: true },
    });
    if (!mod) {
      throw new NotFoundException("Module not found");
    }

    const subtopics = await this.prisma.subtopic.findMany({
      where: { moduleId },
      select: {
        id: true,
        title: true,
        order: true,
        tutorialContent: {
          where: { styleBucket: "neutral" },
          select: { explanation: true, diagramSpec: true, example: true },
          orderBy: { generatedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { order: "asc" },
    });

    // Structured document shape — built here so the read/transform logic
    // is exercised, even though the PDF renderer is stubbed.
    const _result = {
      moduleTitle: mod.title,
      subtopics: subtopics.map((st) => ({
        title: st.title,
        explanation: st.tutorialContent[0]?.explanation ?? null,
        diagramSpec: st.tutorialContent[0]?.diagramSpec ?? null,
        example: st.tutorialContent[0]?.example ?? null,
      })),
    };

    // TODO(F13): wire PDF rendering. Once a PDF library is added, pass
    // `_result` to the renderer and stream as a file download.
    void _result;
    throw new NotImplementedException(
      "PDF rendering not yet available — needs a PDF library (puppeteer / jspdf / pdfkit). " +
        "The read/transform logic is complete; only the file generation is stubbed.",
    );
  }

  /**
   * Notion export — blocked until Notion OAuth connection storage exists.
   *
   * F13 step 3 assumes "if the student has connected a Notion account,"
   * but there is no `notion_connections` table or OAuth flow anywhere in
   * the schema. Until that infrastructure lands, this endpoint has no way
   * to check connection status or retrieve an access token.
   */
  async exportNotion(_moduleId: string, _userId: string): Promise<never> {
    throw new NotImplementedException(
      "Notion export not yet available — needs a `notion_connections` table " +
        "(user_id, access_token, workspace_id, connected_at) and an OAuth callback flow.",
    );
  }
}
