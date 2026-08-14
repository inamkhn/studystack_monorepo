import { IsEnum, IsOptional, IsString } from "class-validator";
import { Goal, Level } from "../../generated/prisma/client.js";

export class PublicQueryDto {
  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsEnum(Level)
  level?: Level;

  @IsOptional()
  @IsEnum(Goal)
  goal?: Goal;
}
