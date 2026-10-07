// ── F1 §41/§42: ingestion telemetry ────────────────────────────────────
// One dependency-free home for the three observability concerns the
// upload path needs:
//   1. correlated structured LOGGING — every line carries the §41
//      identifiers (courseId, sourceDocumentId, ingestionRunId,
//      pipelineVersion) and NEVER document content (design §41 last line:
//      "Do not log textbook contents"). Only ids, codes, counts, durations.
//   2. METRICS — the §41 recommended counters + duration distributions,
//      kept in-process (BullMQ runs one worker; counters are cheap and a
//      real exporter can be attached via the MetricsExporter seam).
//   3. STAGE TRACING — span(name, ids) → end() records wall-clock
//      duration and emits a structured event, forming the §42 tree
//      (ingestDocument → validateFile … extractPages[batch:n] … embedChunks).
//
// It is intentionally correlation-agnostic: callers pass the ids they
// already hold (explicit over ambient), which keeps the worker readable
// and the callsites unit-testable.

import { Injectable, Logger } from "@nestjs/common";
import type { MetricsExporter, MetricsSnapshot } from "./metrics-exporter.js";

/** §41 identifiers attached to every log/trace/metric label set. */
export interface CorrelationIds {
  courseId?: string;
  sourceDocumentId?: string;
  ingestionRunId?: string;
  pipelineVersion?: string;
}

/** §41 recommended metric names, centralized to avoid stringly drift. */
export const METRICS = {
  uploadsStarted: "uploads_started",
  uploadsFinalized: "uploads_finalized",
  uploadsRejected: "uploads_rejected",
  ingestionSuccess: "ingestion_success",
  ingestionFailure: "ingestion_failure",
  queueWaitSeconds: "queue_wait_seconds",
  ingestionDurationSeconds: "ingestion_duration_seconds",
  pagesProcessed: "pages_processed",
  pagesOcr: "pages_ocr",
  ocrDurationSeconds: "ocr_duration_seconds",
  ocrFailure: "ocr_failure",
  parserFailure: "parser_failure",
  chunksPerDocument: "chunks_per_document",
  assetsWritten: "assets_written",
  embeddingBatches: "embedding_batches",
  embeddingFailure: "embedding_failure",
  needsResearchFillFlagged: "needs_research_fill_flagged",
  stageDurationSeconds: "stage_duration_seconds",
} as const;

/** A running open span; call end() to close + record it. */
export interface TraceSpan {
  end(fields?: Record<string, unknown>): number;
}

interface DistAggregate {
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[]; // bounded reservoir for percentiles
}

const RESERVOIR = 2048;

@Injectable()
export class IngestionTelemetry {
  private readonly logger = new Logger("ingestion.telemetry");
  private readonly counters = new Map<string, number>();
  private readonly distributions = new Map<string, DistAggregate>();
  private readonly exporters: MetricsExporter[] = [];

  /** Structured, content-free event line (JSON for log-pipeline parsing). */
  logEvent(
    level: "log" | "warn" | "error",
    event: string,
    ids: CorrelationIds,
    fields: Record<string, unknown> = {},
  ): void {
    const line = JSON.stringify({
      event,
      ...(ids.courseId ? { courseId: ids.courseId } : {}),
      ...(ids.sourceDocumentId ? { sourceDocumentId: ids.sourceDocumentId } : {}),
      ...(ids.ingestionRunId ? { ingestionRunId: ids.ingestionRunId } : {}),
      ...(ids.pipelineVersion ? { pipelineVersion: ids.pipelineVersion } : {}),
      ...fields,
    });
    this.logger[level](line);
  }

  /** Counter increment; optional labels become part of the metric key. */
  increment(
    name: string,
    by = 1,
    labels?: Record<string, string | number>,
  ): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Records one observation into a duration/count distribution. */
  observe(
    name: string,
    value: number,
    labels?: Record<string, string | number>,
  ): void {
    const key = labelKey(name, labels);
    let agg = this.distributions.get(key);
    if (!agg) {
      agg = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, samples: [] };
      this.distributions.set(key, agg);
    }
    agg.count += 1;
    agg.sum += value;
    agg.min = Math.min(agg.min, value);
    agg.max = Math.max(agg.max, value);
    if (agg.samples.length < RESERVOIR) agg.samples.push(value);
  }

  /**
   * Opens a §42 stage span. end() computes wall-clock duration, records
   * stage_duration_seconds{stage}, logs the completion event with the
   * correlation ids + any extra fields, and returns the duration in ms.
   */
  span(name: string, ids: CorrelationIds): TraceSpan {
    const start = performance.now();
    this.logEvent("log", `${name}:start`, ids);
    return {
      end: (fields: Record<string, unknown> = {}): number => {
        const durationMs = Math.round(performance.now() - start);
        this.observe(METRICS.stageDurationSeconds, durationMs / 1000, { stage: name });
        this.logEvent("log", `${name}:end`, ids, { durationMs, ...fields });
        return durationMs;
      },
    };
  }

  /** Registers a real exporter (Prometheus/Sentry/…) for snapshot pushes. */
  registerExporter(exporter: MetricsExporter): void {
    this.exporters.push(exporter);
  }

  /** Point-in-time rollup of all counters + distribution aggregates. */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) counters[key] = value;

    const distributions: MetricsSnapshot["distributions"] = {};
    for (const [key, agg] of this.distributions) {
      distributions[key] = {
        count: agg.count,
        sum: round(agg.sum),
        min: round(agg.count ? agg.min : 0),
        max: round(agg.max),
        mean: round(agg.count ? agg.sum / agg.count : 0),
        p50: round(percentile(agg.samples, 0.5)),
        p95: round(percentile(agg.samples, 0.95)),
      };
    }
    return { generatedAt: new Date().toISOString(), counters, distributions };
  }

  /** Pushes the current snapshot to every registered exporter. */
  async flush(): Promise<MetricsSnapshot> {
    const snap = this.snapshot();
    for (const exporter of this.exporters) {
      // Promise.resolve wraps a possibly-sync (void) export so a throwing
      // exporter never breaks ingestion.
      await Promise.resolve(exporter.export(snap)).catch(() => undefined);
    }
    return snap;
  }
}

function labelKey(
  name: string,
  labels?: Record<string, string | number>,
): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(",")}}`;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
