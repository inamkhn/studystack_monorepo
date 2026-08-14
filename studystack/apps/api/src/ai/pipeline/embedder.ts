// ── Embedding stage (F1 Phase B) ───────────────────────────────────────
// Embeds source_chunks via the Gateway embedding model and writes vectors
// into the pgvector columns (Prisma can't write `Unsupported vector`
// fields, so writes go through $executeRaw).
//
// Dimension policy: the schema is vector(768). Gemini embeddings are
// Matryoshka — when the provider returns a wider vector we truncate to 768
// and re-normalize (officially supported for gemini-embedding models),
// which keeps this working regardless of provider-default dimensionality.

import type { PrismaService } from "../../prisma/prisma.service.js";
import { setChunkScope } from "../../common/utils/chunk-scope.js";
import { buildEmbeddings } from "../gateway.js";

export const EMBEDDING_DIM = 768;

/** Truncate/validate a raw vector to the schema dimension, L2-normalized. */
export function toSchemaVector(vector: number[]): number[] {
  if (vector.length < EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension ${vector.length} is below the schema's ${EMBEDDING_DIM}`,
    );
  }
  const slice = vector.slice(0, EMBEDDING_DIM);
  const norm = Math.sqrt(slice.reduce((sum, v) => sum + v * v, 0));
  if (!norm) {
    throw new Error("Embedding is a zero vector — provider returned no signal");
  }
  return slice.map((v) => v / norm);
}

/**
 * Embeds every chunk of a course that lacks an embedding. Idempotent —
 * a re-run only fills missing rows. Returns how many were embedded.
 */
export async function embedCourseChunks(
  prisma: PrismaService,
  courseId: string,
): Promise<number> {
  // RLS scope: both the read and the vector writes run under
  // app.current_course_id (llm-handling §3.2b). The embedding call itself
  // stays outside the transactions so no DB locks are held during the
  // provider round-trip.
  const rows = await prisma.$transaction(async (tx) => {
    await setChunkScope(tx, courseId);
    return tx.$queryRaw<{ id: string; text: string }[]>`
      SELECT id, "chunkText" AS text
      FROM source_chunks
      WHERE "courseId" = ${courseId} AND embedding IS NULL
      ORDER BY "createdAt"
    `;
  });

  if (rows.length === 0) return 0;

  const embeddings = buildEmbeddings();
  const vectors = await embeddings.embedDocuments(
    rows.map((row) => row.text),
  );

  if (vectors.length !== rows.length) {
    throw new Error(
      `Embedding count mismatch: ${vectors.length} vectors for ${rows.length} chunks`,
    );
  }

  // Batched writes — one scoped transaction per batch keeps memory and lock
  // time bounded on large courses.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((row, j) => toSchemaVector(vectors[i + j]));
    await prisma.$transaction(async (tx) => {
      await setChunkScope(tx, courseId);
      for (let j = 0; j < batch.length; j++) {
        const row = rows[i + j];
        await tx.$executeRaw`
          UPDATE source_chunks
          SET embedding = ${JSON.stringify(batch[j])}::vector
          WHERE id = ${row.id}
        `;
      }
    });
  }

  return rows.length;
}

/** Embeds a batch of concept rows ({id, text}) and stores the vectors. */
export async function embedConceptRows(
  prisma: PrismaService,
  rows: { id: string; text: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const embeddings = buildEmbeddings();
  const vectors = await embeddings.embedDocuments(rows.map((r) => r.text));
  const updates = rows.map((row, i) => {
    const vector = toSchemaVector(vectors[i]);
    return prisma.$executeRaw`
      UPDATE concepts SET embedding = ${JSON.stringify(vector)}::vector
      WHERE id = ${row.id}
    `;
  });
  await prisma.$transaction(updates);
}

/** Embeds a single concept (canonical name + aliases) and stores it. */
export async function embedConcept(
  prisma: PrismaService,
  conceptId: string,
  canonicalName: string,
  aliases: string[],
): Promise<void> {
  const embeddings = buildEmbeddings();
  const text = aliases.length
    ? `${canonicalName} (${aliases.join(", ")})`
    : canonicalName;
  const [vector] = await embeddings.embedDocuments([text]);
  const normalized = toSchemaVector(vector);
  await prisma.$executeRaw`
    UPDATE concepts SET embedding = ${JSON.stringify(normalized)}::vector
    WHERE id = ${conceptId}
  `;
}
