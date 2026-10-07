import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { diskStorage } from "multer";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "path";
import { UPLOAD_MAX_BYTES } from "../uploads/upload-limits.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { UPLOAD_DIR } from "../common/utils/storage.js";
import { CourseMaintenanceService } from "./course-maintenance.service.js";
import { CourseService } from "./course.service.js";
import { ExamDateDto } from "./dto/exam-date.dto.js";
import { GoalDto } from "./dto/goal.dto.js";
import { IntakeDto } from "./dto/intake.dto.js";
import { LevelDto } from "./dto/level.dto.js";
import { PresignUploadDto } from "./dto/presign-upload.dto.js";
import { TopicCourseDto } from "./dto/topic-course.dto.js";
import { UploadCourseDto } from "./dto/upload-course.dto.js";

@ApiTags("courses")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses")
export class CourseController {
  constructor(
    private readonly courseService: CourseService,
    private readonly courseMaintenanceService: CourseMaintenanceService,
  ) {}

  // ── F1: upload path ────────────────────────────────────────────────────
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // F1 §2.2: disk-streamed, never memory-buffered — large (400+ page)
      // files and concurrent uploads don't pressure the heap. Multer writes a
      // temp file; the service renames it to <courseId>-<name> once the
      // course row exists. Multer errors (e.g. size cap) → 413.
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(UPLOAD_DIR, { recursive: true });
          cb(null, UPLOAD_DIR);
        },
        filename: (_req, file, cb) => {
          cb(
            null,
            `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
          );
        },
      }),
      limits: { fileSize: UPLOAD_MAX_BYTES },
    }),
  )
  async uploadCourse(
    @CurrentUser("id") userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadCourseDto,
  ) {
    return this.courseService.createUploadCourse(userId, file, dto.attestRights);
  }

  @Patch(":id/attest-rights")
  async attestRights(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseService.attestRights(userId, courseId);
  }

  // ── F1: S3 presigned upload (browser PUTs direct to AWS) ──────────────
  @Post("uploads/presign")
  @HttpCode(HttpStatus.CREATED)
  async presignUpload(
    @CurrentUser("id") userId: string,
    @Body() dto: PresignUploadDto,
  ) {
    return this.courseService.presignUpload(userId, {
      filename: dto.filename,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      attestRights: dto.attestRights,
    });
  }

  @Post("uploads/:id/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmUpload(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseService.confirmUpload(userId, courseId);
  }

  @Get(":id/ingestion-status")
  async getIngestionStatus(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseService.getIngestionStatus(userId, courseId);
  }

  // F1 §4.3: owner-only hard delete — DB rows plus uploaded file and
  // extracted figures. Blocked (409) when forks/purchases/classrooms/
  // certificates exist.
  @Delete(":id")
  async deleteCourse(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseMaintenanceService.deleteCourse(userId, courseId);
  }

  // ── F2: topic-only path ────────────────────────────────────────────────

  @Post("topic")
  @HttpCode(HttpStatus.CREATED)
  async createTopicCourse(
    @CurrentUser("id") userId: string,
    @Body() dto: TopicCourseDto,
  ) {
    return this.courseService.createTopicCourse(userId, dto.topic);
  }

  // ── F3: intake, level, goal, exam date ─────────────────────────────────

  @Patch(":id/intake")
  async updateIntake(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: IntakeDto,
  ) {
    return this.courseService.updateIntake(userId, courseId, dto.goal, dto.level);
  }

  @Patch(":id/level")
  async updateLevel(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: LevelDto,
  ) {
    return this.courseService.updateLevel(userId, courseId, dto.level);
  }

  @Patch(":id/goal")
  async updateGoal(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: GoalDto,
  ) {
    return this.courseService.updateGoal(userId, courseId, dto.goal);
  }

  @Patch(":id/exam-date")
  async updateExamDate(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Body() dto: ExamDateDto,
  ) {
    return this.courseService.updateExamDate(userId, courseId, dto.examDate);
  }

  // ── F4: generated structure ────────────────────────────────────────────

  @Get(":id/structure")
  async getStructure(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseService.getStructure(userId, courseId);
  }

  // F14 publish/fork/report moved to SharingModule (share.controller.ts) —
  // same routes, single-responsibility split.
}
