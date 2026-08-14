import { Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { CourseService } from "./course.service.js";

/**
 * F1 §4.2/§4.3 — operational maintenance endpoints.
 *
 * Without Redis there is no repeatable BullMQ schedule, so reconciliation
 * and the failed-course TTL sweep are admin-triggered (wire them to a cron
 * once Redis is up). Both are idempotent and safe to run repeatedly.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
@Controller("admin/courses")
export class AdminCourseMaintenanceController {
  constructor(private readonly courseService: CourseService) {}

  // F1 §4.2: re-enqueue courses stranded without a live job (Redis outage,
  // crashed worker, exhausted retries).
  @Post("reconcile")
  @HttpCode(HttpStatus.OK)
  async reconcileStuckCourses() {
    return this.courseService.reconcileStuckCourses();
  }

  // F1 §4.3: TTL sweep — hard-delete courses stuck in `failed` past the
  // retention window.
  @Post("cleanup-failed")
  @HttpCode(HttpStatus.OK)
  async cleanupFailedCourses() {
    return this.courseService.cleanupFailedCourses();
  }
}
