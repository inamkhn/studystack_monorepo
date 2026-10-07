// ── F1 §41/§42: observability module ───────────────────────────────────
// Provides IngestionTelemetry to both the HTTP upload entrypoints and the
// ingestion worker, and hosts the admin snapshot endpoint. AuthModule is
// imported for the guards the admin controller shares with the other
// admin endpoints.
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { IngestionTelemetry } from "./ingestion-telemetry.js";
import { ObservabilityController } from "./observability.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [ObservabilityController],
  providers: [IngestionTelemetry],
  exports: [IngestionTelemetry],
})
export class ObservabilityModule {}
