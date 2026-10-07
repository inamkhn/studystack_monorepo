// ── F1 §41: operational metrics endpoint ───────────────────────────────
// The in-process telemetry registry needs a consumer to be more than
// dead weight. This admin-only endpoint surfaces the current snapshot —
// counters, duration percentiles, and the two derived rates — plus a live
// stuck-ingestion gauge read straight from the DB. A future Prometheus
// /metrics scrape or Sentry flush would register a MetricsExporter and
// call telemetry.flush(); this endpoint is the vendor-free equivalent.
import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiQuery, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { METRICS, IngestionTelemetry } from "./ingestion-telemetry.js";

const STUCK_AFTER_MS = 30 * 60 * 1000;

@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
@Controller("admin/observability")
export class ObservabilityController {
  constructor(
    private readonly telemetry: IngestionTelemetry,
    private readonly prisma: PrismaService,
  ) {}

  // Counters + duration percentiles + derived ingestion success/failure
  // rate + a live stuck count. `?flush=true` also pushes the snapshot to
  // any registered exporters before returning.
  @Get("ingestion")
  @HttpCode(HttpStatus.OK)
  @ApiQuery({ name: "flush", required: false, type: Boolean })
  async ingestion(@Query("flush") flush?: string) {
    const snapshot =
      flush === "true" ? await this.telemetry.flush() : this.telemetry.snapshot();

    const success = snapshot.counters[METRICS.ingestionSuccess] ?? 0;
    const failure = snapshot.counters[METRICS.ingestionFailure] ?? 0;
    const attempts = success + failure;

    const stuck = await this.prisma.course.count({
      where: {
        status: { in: ["ingesting", "structuring"] },
        updatedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) },
      },
    });

    return {
      ...snapshot,
      rates: {
        ingestionSuccess: attempts ? round(success / attempts) : null,
        ingestionFailure: attempts ? round(failure / attempts) : null,
      },
      gauges: { stuckIngestionCount: stuck },
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
