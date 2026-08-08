import { IsEnum, IsOptional, IsString } from "class-validator";
import { Goal, Level } from "@prisma/client";

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
