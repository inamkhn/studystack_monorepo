import {
  Body,
  Controller,
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
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { CourseService } from "./course.service.js";
import { ExamDateDto } from "./dto/exam-date.dto.js";
import { GoalDto } from "./dto/goal.dto.js";
import { IntakeDto } from "./dto/intake.dto.js";
import { LevelDto } from "./dto/level.dto.js";
import { TopicCourseDto } from "./dto/topic-course.dto.js";
import { UploadCourseDto } from "./dto/upload-course.dto.js";

@ApiTags("courses")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("courses")
export class CourseController {
  constructor(private readonly courseService: CourseService) {}

  // ── F1: upload path ────────────────────────────────────────────────────

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // Memory-buffered until object storage is wired — guard against
      // unbounded uploads (multer error → 413 PayloadTooLargeException).
      limits: { fileSize: 50 * 1024 * 1024 },
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

  @Get(":id/ingestion-status")
  async getIngestionStatus(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
  ) {
    return this.courseService.getIngestionStatus(userId, courseId);
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

  // ── F15: concept links for one subtopic ────────────────────────────────

  @Get(":id/subtopics/:subtopicId/concept-links")
  async getConceptLinks(
    @CurrentUser("id") userId: string,
    @Param("id") courseId: string,
    @Param("subtopicId") subtopicId: string,
  ) {
    return this.courseService.getConceptLinks(userId, courseId, subtopicId);
  }
}
