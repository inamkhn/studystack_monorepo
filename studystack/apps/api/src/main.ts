import { existsSync } from "node:fs";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

// Env vars live in the monorepo-root .env (two levels up from apps/api).
// Load before bootstrap so ConfigModule and the Prisma driver adapter both
// see DATABASE_URL & co.
for (const candidate of ["../../.env", ".env"]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS — the Next.js web app (dev: localhost:3000) consumes this API.
  // CORS_ORIGIN may be a comma-separated allowlist; defaults to reflecting
  // any origin (dev-friendly, tighten before production).
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors(
    corsOrigin
      ? { origin: corsOrigin.split(",").map((o) => o.trim()) }
      : undefined,
  );

  // Auth rate limiting keys off req.ip. Honor X-Forwarded-For only when
  // TRUST_PROXY is explicitly set — trusting it unconditionally would let
  // clients spoof their IP and dodge the throttles.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set("trust proxy", Number(trustProxy) || 1);
  }

  // OpenAPI spec served at /docs — the source for packages/api-client codegen.
  const swaggerConfig = new DocumentBuilder()
    .setTitle("StudyStack API")
    .setDescription(
      "StudyStack API — OpenAPI spec consumed by @studystack/api-client (openapi-typescript)",
    )
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document);

  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
