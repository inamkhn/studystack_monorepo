import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";
import { ExplanationStyle } from "../../generated/prisma/client.js";

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "birthDate must be a full date in YYYY-MM-DD format",
  })
  // F6 gate: server derives the bracket (>= 18 → adult, else unknown) —
  // clients can never claim adult without a birth date.
  birthDate?: string;

  @IsOptional()
  @IsEnum(ExplanationStyle)
  // null clears the persona back to the neutral bucket (Feature 18).
  explanationStyle?: ExplanationStyle | null;
}
