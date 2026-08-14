import { IsEnum } from "class-validator";
import { Goal } from "../../generated/prisma/client.js";

export class GoalDto {
  @IsEnum(Goal)
  goal!: Goal;
}
