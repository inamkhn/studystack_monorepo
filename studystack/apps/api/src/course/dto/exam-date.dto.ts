import { IsDateString, ValidateIf } from "class-validator";

export class ExamDateDto {
  /** ISO-8601 date (YYYY-MM-DD) to set, or null to clear. */
  @ValidateIf((o) => o.examDate !== null && o.examDate !== undefined)
  @IsDateString()
  examDate!: string | null;
}
