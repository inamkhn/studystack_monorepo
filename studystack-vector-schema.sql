-- StudyStack — vector database schema
-- Run this AFTER the Prisma-generated migration for apps/api/prisma/schema.prisma,
-- and BEFORE any embedding writes.
--
-- IMPORTANT: Because schema.prisma defines `extensions = [vector]` (with the
-- `postgresqlExtensions` preview feature), Prisma 7 natively generates
-- `CREATE EXTENSION IF NOT EXISTS vector` and correctly creates the
-- `vector(768)` columns when it processes the `Unsupported` type.
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

-- ── qna_messages.embedding ────────────────────────────────────────────────
-- Feature 10 (semantic Q&A cache): near-duplicate question check on incoming
-- questions, scoped to subtopic_id, before any LLM call.

CREATE INDEX IF NOT EXISTS qna_messages_question_embedding_hnsw_idx
  ON qna_messages
  USING hnsw (embedding vector_cosine_ops);

-- ── Row-level security on source_chunks (llm-handling §3.2b) ──────────
-- The LLM-handling doc treats course-scoped isolation as a hard boundary,
-- not an application-level convenience. An app-side "WHERE courseId = ?"
-- on every query is the same guarantee as "the query we usually write" —
-- it fails silently the one time a call site forgets it. RLS makes the
-- omission impossible instead of just unlikely.
--
-- Enforcement contract: every app-side read/write of source_chunks runs
-- inside a transaction that first sets the session variable
-- (`apps/api/src/common/utils/chunk-scope.ts` →
-- `set_config('app.current_course_id', <courseId>, is_local)`).
--
-- Note on FORCE: ENABLE (not FORCE) — the table owner bypasses RLS unless
-- FORCE is set, and current deployments connect as the owner (Neon
-- single-role). The policy is the enforced backstop the moment the API
-- runs under a dedicated non-owner role; flip to FORCE ROW LEVEL SECURITY
-- at that time.
ALTER TABLE source_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_chunks_course_isolation ON source_chunks;
-- "courseId" is TEXT (Prisma String ids); current_setting(..., true)
-- returns NULL when unset, and NULL = anything denies the row.
CREATE POLICY source_chunks_course_isolation ON source_chunks
  USING ("courseId" = current_setting('app.current_course_id', true));

-- ── Example queries (reference only, not run by this migration) ─────────
-- Nearest-neighbor chunk retrieval, course-scoped, for tutorial generation.
-- Run inside a transaction that has set app.current_course_id (RLS admits
-- only that course's rows even if the WHERE clause were ever forgotten):
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
