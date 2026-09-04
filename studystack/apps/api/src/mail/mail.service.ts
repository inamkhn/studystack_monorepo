import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>("RESEND_API_KEY", "");
    this.from = config.get<string>(
      "MAIL_FROM",
      "StudyStack <onboarding@resend.dev>",
    );
    this.resend = apiKey ? new Resend(apiKey) : null;
    if (!this.resend) {
      this.logger.warn(
        "RESEND_API_KEY is not set — password-reset emails will be logged, not sent",
      );
    }
  }

  async sendPasswordReset(
    email: string,
    resetUrl: string,
  ): Promise<void> {
    if (!this.resend) {
      this.logger.log(`[dev] password reset for ${email}: ${resetUrl}`);
      return;
    }

    const { data, error } = await this.resend.emails.send(
      {
        from: this.from,
        to: [email],
        subject: "Reset your StudyStack password",
        html: `<p>You requested a password reset. This link expires in 30 minutes:</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`,
        tags: [{ name: "category", value: "password-reset" }],
      },
      { idempotencyKey: `password-reset/${email}/${Date.now()}` },
    );

    if (error) {
      this.logger.error(`Resend failed to send reset email: ${error.message}`);
      return;
    }

    this.logger.log(`Password-reset email sent: ${data?.id}`);
  }
}
