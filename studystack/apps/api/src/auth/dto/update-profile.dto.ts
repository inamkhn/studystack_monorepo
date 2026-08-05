import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { ExplanationStyle } from "@prisma/client";

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEnum(ExplanationStyle)
  explanationStyle?: ExplanationStyle;
}
