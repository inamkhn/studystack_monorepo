import { Transform } from "class-transformer";
import { IsIn, IsOptional } from "class-validator";

export class UploadCourseDto {
  /**
   * F1 — early rights attestation. Arrives as a multipart form field, so it is
   * a string ("true"/"false") by the time it reaches validation. Coerce both
   * forms to a real boolean; anything else is rejected (Boolean("false") is
   * `true`, so no naive coercion).
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === false) return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value; // invalid — rejected by @IsIn below
  })
  @IsIn([true, false])
  attestRights?: boolean;
}
