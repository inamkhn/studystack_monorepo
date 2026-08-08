import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { ExportService } from "./export.service.js";

@ApiTags("export")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("modules")
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  // ── F13: Anki flashcard export ─────────────────────────────────────

  @Get(":id/export/anki")
  async exportAnki(@Param("id") moduleId: string) {
    return this.exportService.exportAnki(moduleId);
  }

  // ── F13: PDF export ────────────────────────────────────────────────

  @Get(":id/export/pdf")
  async exportPdf(@Param("id") moduleId: string) {
    return this.exportService.exportPdf(moduleId);
  }

  // ── F13: Notion export ─────────────────────────────────────────────

  @Post(":id/export/notion")
  async exportNotion(
    @CurrentUser("id") userId: string,
    @Param("id") moduleId: string,
  ) {
    return this.exportService.exportNotion(moduleId, userId);
  }
}
