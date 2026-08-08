import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ReportDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  reason!: string;
}
