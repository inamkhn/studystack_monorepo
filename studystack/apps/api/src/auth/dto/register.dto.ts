import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  // bcrypt only reads the first 72 bytes — cap the input so longer
  // passwords can't hash-collide or DoS the hashing step.
  @MaxLength(72)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}
