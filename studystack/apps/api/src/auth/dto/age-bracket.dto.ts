import { IsDateString, Matches } from "class-validator";

export class AgeBracketDto {
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "birthDate must be a full date in YYYY-MM-DD format" })
  birthDate!: string;
}
