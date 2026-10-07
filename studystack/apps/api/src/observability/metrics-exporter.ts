// ── F1 §41/§42: metrics exporter seam ──────────────────────────────────
// No metrics vendor is wired in (the repo has no Prometheus/OTel/Sentry
// dependency), so the ingestion telemetry keeps its own in-process
// registry and pushes snapshots through this seam. A real exporter is a
// drop-in: implement the interface and register it with
// IngestionTelemetry.registerExporter(exporter) — every recorded metric
// then flows through on flush(), with no call-site changes. This mirrors
// the Phase-3 AV-scan seam.
export interface MetricsSnapshot {
  generatedAt: string;
  /** Monotonic counters, keyed by name (+ optional labels). */
  counters: Record<string, number>;
  /** Duration/count distributions with rolling aggregates + percentiles. */
  distributions: Record<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      mean: number;
      p50: number;
      p95: number;
    }
  >;
}

export interface MetricsExporter {
  /** Called on demand (e.g. an admin flush) with the current snapshot. */
  export(snapshot: MetricsSnapshot): void | Promise<void>;
}
