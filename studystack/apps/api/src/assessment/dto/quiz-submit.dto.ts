import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

export class QuizAnswerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  questionId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  answer!: string;
}

export class QuizSubmitDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  answers!: QuizAnswerDto[];
}
