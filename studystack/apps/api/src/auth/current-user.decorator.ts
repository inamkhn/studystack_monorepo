import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { JwtUser } from "./types.js";

export const CurrentUser = createParamDecorator(
  (data: keyof JwtUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user: JwtUser }>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
