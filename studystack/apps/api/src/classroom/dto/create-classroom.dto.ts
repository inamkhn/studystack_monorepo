import { IsBoolean, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateClassroomDto {
  @IsUUID()
  courseId!: string;

  @IsBoolean()
  consentOnFile!: boolean;

  @IsOptional()
  @IsString()
  consentDocumentUrl?: string;
}
