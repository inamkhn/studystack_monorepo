import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { INGESTION_QUEUE } from "./jobs.constants.js";

/**
 * F1 — async ingestion worker (BullMQ).
 *
 * STUB: the real pipeline (document parsing → chunking → embedding →
 * needs_research_fill backfill enqueue) lands with AiModule per the build
 * order. Until then, courses intentionally stay in `ingesting` rather than
 * faking completion.
 */
@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  async process(job: Job<{ courseId: string }>): Promise<void> {
    this.logger.warn(
      `[stub] ingestion for course ${job.data.courseId} — extraction pipeline not yet implemented (AiModule step); course remains ingesting`,
    );
  }
}
