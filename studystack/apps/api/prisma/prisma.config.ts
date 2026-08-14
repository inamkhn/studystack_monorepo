import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env files. The single source of truth for
// env vars is the monorepo-root .env (three levels up from this file, since
// it lives in apps/api/prisma/); fall back to an apps/api-level .env.
// Paths are resolved from this file, not from cwd — the Prisma CLI may be
// launched from the workspace root.
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "../../../.env"), resolve(here, "../.env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    console.error(`[prisma.config] loaded env from ${candidate}`);
    break;
  }
}

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
