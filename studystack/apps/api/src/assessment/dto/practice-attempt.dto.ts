import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from "class-validator";

export class PracticeAttemptDto {
  @IsInt()
  @Min(0)
  @Max(20)
  hintsUsed!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  answer!: string;
}
