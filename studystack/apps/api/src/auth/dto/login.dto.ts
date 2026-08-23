import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  // Same 72-byte cap as registration — oversized inputs would only burn
  // bcrypt CPU for no possible match.
  @MaxLength(72)
  password!: string;
}
