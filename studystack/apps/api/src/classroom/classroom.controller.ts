import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { ClassroomService } from "./classroom.service.js";
import { CreateClassroomDto } from "./dto/create-classroom.dto.js";
import { JoinClassroomDto } from "./dto/join-classroom.dto.js";

@ApiTags("classrooms")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("classrooms")
export class ClassroomController {
  constructor(private readonly classroomService: ClassroomService) {}

  // ── F19: create a classroom (teacher only) ──────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles("teacher")
  @HttpCode(HttpStatus.CREATED)
  async createClassroom(
    @CurrentUser("id") teacherId: string,
    @Body() dto: CreateClassroomDto,
  ) {
    return this.classroomService.createClassroom(teacherId, {
      courseId: dto.courseId,
      consentOnFile: dto.consentOnFile,
      consentDocumentUrl: dto.consentDocumentUrl,
    });
  }

  // ── F19: generate / refresh invite code (teacher only) ──────────────────

  @Post(":id/invite")
  @UseGuards(RolesGuard)
  @Roles("teacher")
  async generateInviteCode(
    @CurrentUser("id") teacherId: string,
    @Param("id") classroomId: string,
  ) {
    return this.classroomService.generateInviteCode(teacherId, classroomId);
  }

  // ── F19: join a classroom via invite code (any authenticated student) ───

  @Post(":id/join")
  @HttpCode(HttpStatus.OK)
  async joinClassroom(
    @CurrentUser("id") studentId: string,
    @Param("id") classroomId: string,
    @Body() dto: JoinClassroomDto,
  ) {
    return this.classroomService.joinClassroom(
      studentId,
      classroomId,
      dto.inviteCode,
    );
  }

  // ── F19: roster (teacher only) ──────────────────────────────────────────

  @Get(":id/roster")
  @UseGuards(RolesGuard)
  @Roles("teacher")
  async getRoster(
    @CurrentUser("id") teacherId: string,
    @Param("id") classroomId: string,
  ) {
    return this.classroomService.getRoster(teacherId, classroomId);
  }

  // ── F19: aggregated dashboard (teacher only) ────────────────────────────

  @Get(":id/dashboard")
  @UseGuards(RolesGuard)
  @Roles("teacher")
  async getDashboard(
    @CurrentUser("id") teacherId: string,
    @Param("id") classroomId: string,
  ) {
    return this.classroomService.getDashboard(teacherId, classroomId);
  }
}
