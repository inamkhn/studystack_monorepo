import { IsEnum } from "class-validator";
import { Level } from "../../generated/prisma/client.js";

export class LevelDto {
  @IsEnum(Level)
  level!: Level;
}
