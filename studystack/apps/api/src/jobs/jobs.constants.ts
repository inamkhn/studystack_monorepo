// Queue names for BullMQ, shared between producers (services) and consumers
// (processors in this module).

export const INGESTION_QUEUE = "ingestion";
export const RESEARCH_QUEUE = "research";
export const STRUCTURING_QUEUE = "structuring";
export const MASTERY_DECAY_QUEUE = "mastery-decay";

/**
 * F1 resolution — BullMQ priority field; lower number = higher priority.
 * - new_course_ingestion: brand-new upload/topic course (runs immediately)
 * - research_fill_backfill: needs_research_fill backfill jobs (runs when idle)
 * - regeneration: mid-course re-generation after level changes etc.
 */
export const JOB_PRIORITY = {
  newCourseIngestion: 1,
  researchFillBackfill: 2,
  regeneration: 3,
} as const;
