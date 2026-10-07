import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { UploadsModule } from "../uploads/uploads.module.js";
import { ObservabilityModule } from "../observability/observability.module.js";
import { AdminCourseMaintenanceController } from "./admin-course-maintenance.controller.js";
import { CourseController } from "./course.controller.js";
import { CourseMaintenanceService } from "./course-maintenance.service.js";
import { CourseService } from "./course.service.js";

@Module({
  imports: [AuthModule, JobsModule, UploadsModule, ObservabilityModule],
  controllers: [CourseController, AdminCourseMaintenanceController],
  providers: [CourseService, CourseMaintenanceService],
  exports: [CourseService],
})
export class CourseModule {}
