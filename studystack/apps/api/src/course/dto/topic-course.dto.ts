import { IsNotEmpty, IsString } from "class-validator";

export class TopicCourseDto {
  @IsString()
  @IsNotEmpty()
  topic!: string;
}
