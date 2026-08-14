// ── source_chunks course-scoped access (llm-handling §3.2b) ────────────
// Row-level security on source_chunks treats course isolation as a hard
// boundary, not an application convenience: the table's RLS policy only
// admits rows whose "courseId" matches the transaction-local setting
// `app.current_course_id`. An app-side `WHERE courseId = ?` is the same
// guarantee as "the query we usually write" — it fails silently the one
// time a call site forgets it. The GUC makes the omission impossible.
//
// Contract: EVERY read/write of source_chunks goes through withChunkScope
// (or, inside an existing interactive transaction, setChunkScope). Plain
// prisma.sourceChunk.* calls outside that scope are a guardrail violation.

import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaService } from "../../prisma/prisma.service.js";

type TxClient = Prisma.TransactionClient;

/**
 * Sets the RLS scope for the current transaction. Must run before any
 * source_chunks statement inside the same interactive transaction.
 */
export async function setChunkScope(
  tx: TxClient,
  courseId: string,
): Promise<void> {
  // set_config(name, value, is_local=true) ≡ SET LOCAL, parameter-safe.
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_course_id', $1, true)`,
    courseId,
  );
}

/**
 * Runs `fn` inside an interactive transaction with the RLS scope bound to
 * one course. Use this for standalone source_chunks access; call sites
 * already inside an interactive transaction use setChunkScope instead.
 */
export function withChunkScope<T>(
  prisma: PrismaService,
  courseId: string,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setChunkScope(tx, courseId);
    return fn(tx);
  });
}
