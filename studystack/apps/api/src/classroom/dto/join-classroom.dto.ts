import { IsNotEmpty, IsString } from "class-validator";

export class JoinClassroomDto {
  @IsString()
  @IsNotEmpty()
  inviteCode!: string;
}
