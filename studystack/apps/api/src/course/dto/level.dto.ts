import { IsEnum } from "class-validator";
import { Level } from "@prisma/client";

export class LevelDto {
  @IsEnum(Level)
  level!: Level;
}
