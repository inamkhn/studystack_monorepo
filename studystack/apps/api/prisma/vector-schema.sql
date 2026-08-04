-- StudyStack — vector database schema
-- Run this AFTER the Prisma-generated migration for studystack-schema.prisma,
-- and BEFORE any embedding writes.
--
-- IMPORTANT: Because schema.prisma defines `extensions = [vector]`, Prisma 5+ 
-- natively generates `CREATE EXTENSION IF NOT EXISTS vector` and correctly creates 
-- the `vector(768)` columns when it processes the `Unsupported` type. 
-- You do NOT need to ALTER the columns or manually create the extension.
--
-- This script solely exists to attach the HNSW indexes, which Prisma does not 
-- natively generate.
--
-- Dimension: 768, assuming Gemini Embedding with Matryoshka truncation.
-- If you switch embedding models or dimensions later, this whole file needs
-- re-running against a re-embedded dataset — it is not a config toggle.

-- ── source_chunks.embedding ────────────────────────────────────────────
-- Feature 5 (tutorial generation retrieval) and Feature 10 (Q&A semantic
-- cache) both query this column.

-- HNSW over IVFFlat: no training step needed, and query recall stays good
-- without periodic re-tuning as the table grows — a better fit than IVFFlat
-- for a table that keeps growing via ongoing uploads rather than being
-- built once and left static.
CREATE INDEX IF NOT EXISTS source_chunks_embedding_hnsw_idx
  ON source_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Note: The courseId standard index is now managed natively in schema.prisma 
-- via @@index([courseId]).

-- ── concepts.embedding ──────────────────────────────────────────────────
-- Used by concept resolution (Feature 4) to classify a new subtopic as
-- confident_match / ambiguous / no_match against existing canonical concepts.

CREATE INDEX IF NOT EXISTS concepts_embedding_hnsw_idx
  ON concepts
  USING hnsw (embedding vector_cosine_ops);

-- ── Row-level security on source_chunks (recommended, not yet enforced) ──
-- The LLM-handling doc treats course-scoped isolation as a hard boundary,
-- not an application-level convenience. An app-side "WHERE courseId = ?"
-- on every query is the same guarantee as "the query we usually write" —
-- it fails silently the one time a call site forgets it. RLS makes the
-- omission impossible instead of just unlikely.
--
-- Left commented out rather than applied automatically: enabling this
-- requires the API's Postgres role to SET the current course/user context
-- per request (via `SET LOCAL app.current_course_id`), which isn't wired
-- up yet in AiModule. Uncomment and wire the session variable together.
--
-- ALTER TABLE source_chunks ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY source_chunks_course_isolation ON source_chunks
--   USING ("courseId" = current_setting('app.current_course_id')::uuid);

-- ── Example queries (reference only, not run by this migration) ─────────
-- Nearest-neighbor chunk retrieval, course-scoped, for tutorial generation:
--   SELECT id, "chunkText", metadata
--   FROM source_chunks
--   WHERE "courseId" = $1
--   ORDER BY embedding <=> $2::vector
--   LIMIT 8;
--
-- Concept resolution similarity check against canonical concepts:
--   SELECT id, "canonicalName", 1 - (embedding <=> $1::vector) AS similarity
--   FROM concepts
--   ORDER BY embedding <=> $1::vector
--   LIMIT 5;
