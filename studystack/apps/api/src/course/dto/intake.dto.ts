import { IsEnum } from "class-validator";
import { Goal, Level } from "../../generated/prisma/client.js";

export class IntakeDto {
  @IsEnum(Goal)
  goal!: Goal;

  @IsEnum(Level)
  level!: Level;
}
