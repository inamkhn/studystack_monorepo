import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class FinalProjectSubmitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  answer!: string;
}
