import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { MASTERY_DECAY_QUEUE } from "./jobs.constants.js";

/**
 * F8 — periodic mastery-score decay job.
 *
 * Runs on a cron schedule and applies the exponential forgetting-curve decay
 * to every `mastery_scores` row whose `last_reviewed_at` is stale. Also
 * recomputes `next_review_at` for each affected row.
 *
 * The decay formula lives in MasteryService; this processor is responsible
 * for batching and looping over all rows, not computing the math itself.
 *
 * TODO(F8): wire MasteryService.decayAll() once the bulk-decay method lands.
 * Until then, `GET /students/me/due-concepts` still works correctly — it reads
 * `next_review_at` which is set by `recordQuizResult` on each quiz submission.
 */
@Processor(MASTERY_DECAY_QUEUE)
export class MasteryDecayProcessor extends WorkerHost {
  async process(_job: Job): Promise<void> {
    // Stub — the cron registers the queue, the processor is wired,
    // but actual decay logic is deferred to the AiModule pipeline phase
    // when MasteryService.decayAll is implemented.
  }
}
