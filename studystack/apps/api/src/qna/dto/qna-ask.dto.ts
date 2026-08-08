import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class QnaAskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  question!: string;
}
