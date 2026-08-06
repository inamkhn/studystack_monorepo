import { IsEnum } from "class-validator";
import { Goal } from "@prisma/client";

export class GoalDto {
  @IsEnum(Goal)
  goal!: Goal;
}
