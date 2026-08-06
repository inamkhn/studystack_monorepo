import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { RESEARCH_QUEUE } from "./jobs.constants.js";

/**
 * F2 — topic-only course research worker (BullMQ).
 *
 * STUB: the real research step (web search / AI synthesis → topic facts →
 * module-generation handoff) lands with AiModule per the build order.
 */
@Processor(RESEARCH_QUEUE)
export class ResearchProcessor extends WorkerHost {
  private readonly logger = new Logger(ResearchProcessor.name);

  async process(job: Job<{ courseId: string }>): Promise<void> {
    this.logger.warn(
      `[stub] research for course ${job.data.courseId} — research pipeline not yet implemented (AiModule step)`,
    );
  }
}
