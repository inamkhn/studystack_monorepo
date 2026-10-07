import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { CourseModule } from "./course/course.module";
import { ConceptsModule } from "./concepts/concepts.module";
import { SharingModule } from "./sharing/sharing.module";
import { TutorialModule } from "./tutorial/tutorial.module";
import { AssessmentModule } from "./assessment/assessment.module";
import { MasteryModule } from "./mastery/mastery.module";
import { ClassroomModule } from "./classroom/classroom.module";
import { MarketplaceModule } from "./marketplace/marketplace.module";
import { ExportModule } from "./export/export.module";
import { CertificateModule } from "./certificate/certificate.module";
import { QnaModule } from "./qna/qna.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { JobsModule } from "./jobs/jobs.module";
import { StorageModule } from "./storage/storage.module";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    AuthModule,
    CourseModule,
    ConceptsModule,
    SharingModule,
    TutorialModule,
    AssessmentModule,
    MasteryModule,
    ClassroomModule,
    MarketplaceModule,
    ExportModule,
    CertificateModule,
    QnaModule,
    AiModule,
    JobsModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
