import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CertificateController } from "./certificate.controller.js";
import { CertificateService } from "./certificate.service.js";

@Module({
  imports: [AuthModule],
  controllers: [CertificateController],
  providers: [CertificateService],
})
export class CertificateModule {}
