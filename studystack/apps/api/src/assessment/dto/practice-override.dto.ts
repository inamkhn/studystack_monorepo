import { IsBoolean, IsOptional } from "class-validator";

export class PracticeOverrideDto {
  @IsOptional()
  @IsBoolean()
  override?: boolean | null;
}
