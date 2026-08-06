import { IsEnum } from "class-validator";
import { Goal, Level } from "@prisma/client";

export class IntakeDto {
  @IsEnum(Goal)
  goal!: Goal;

  @IsEnum(Level)
  level!: Level;
}
