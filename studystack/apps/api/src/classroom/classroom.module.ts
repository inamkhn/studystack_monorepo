import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ClassroomController } from "./classroom.controller.js";
import { ClassroomService } from "./classroom.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ClassroomController],
  providers: [ClassroomService],
})
export class ClassroomModule {}
