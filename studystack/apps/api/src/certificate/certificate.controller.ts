import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { CertificateService } from "./certificate.service.js";

@ApiTags("certificates")
@Controller()
export class CertificateController {
  constructor(private readonly certificateService: CertificateService) {}

  // ── F16: certificate eligibility check (auth) ───────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("courses/:id/certificate-eligibility")
  async checkEligibility(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.certificateService.checkEligibility(userId, courseId);
  }

  // ── F16: issue certificate (auth, idempotent) ───────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post("courses/:id/certificate")
  async issueCertificate(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.certificateService.issueCertificate(userId, courseId);
  }

  // ── F16: public verification (no auth) ──────────────────────────────

  @Get("certificates/:verificationSlug")
  async getBySlug(@Param("verificationSlug") slug: string) {
    return this.certificateService.getBySlug(slug);
  }
}
