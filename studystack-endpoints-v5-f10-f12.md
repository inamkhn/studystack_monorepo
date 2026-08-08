# StudyStack — Endpoint Stubs: F10 (In-Tutorial Q&A), F12 (Step-by-Step Practice Problems)

Continues from `studystack-endpoints-v4-f8-f11.md`. Two schema gaps surfaced while checking these against the current schema/vector-schema files — flagged inline rather than drafted around silently, since both would block implementation as specced.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## QnAModule — F10 (In-Tutorial Q&A)

`GET /subtopics/:id/qna`
Returns the Q&A message history for this subtopic (own messages only, not the cross-student cache pool below).

`POST /subtopics/:id/qna`
Accepts the student's question. Before generating, checks for a prior answered question on the same `subtopic_id` with high embedding similarity to the incoming question, across all students — on a hit, returns the cached answer instead of calling the model. On a miss, answers grounded in this subtopic's `tutorial_content`, pulling additional chunks via `source_chunks` retrieval if the question needs broader course context, then writes a new `qna_messages` row.

**Schema gap — flagging, not drafting around it:** Feature 10's caching mechanism requires an embedding on `qna_messages.question`, scoped by `subtopic_id`, to run the similarity check described above (*"the similarity check above queries this table directly (embedding on `question`, scoped to `subtopic_id`)"*). The current `QnaMessage` model has no `embedding` column, and `studystack-vector-schema.sql` only defines HNSW indexes for `source_chunks.embedding` and `concepts.embedding` — `qna_messages` isn't mentioned anywhere in that file. As-is, this endpoint's cache-check step has nothing to query. Needs, before implementation: `embedding Unsupported("vector(768)")?` added to `QnaMessage` in the schema, plus a matching `CREATE INDEX ... USING hnsw` entry in the vector-schema file, same pattern as the other two embedded tables.

**Data model:** `qna_messages(id, subtopic_id, student_id, question, answer, timestamp)` — plus the missing `embedding` column above.

---

## AssessmentModule — F12 (Step-by-Step Practice Problems)

`GET /subtopics/:id/practice-problems`
Returns this subtopic's practice problems, generating on first request if not already produced alongside tutorial content (Feature 5). Gated on the calc/application-heavy flag: reads `subtopics.practice_problems_override` first, falling back to the auto-generated flag only when the override is `null`. Returns an empty set (not a 404) for subtopics that don't qualify.

`PATCH /subtopics/:id/practice-problems-override`
Sets or clears `subtopics.practice_problems_override` (`null | true | false`). In classroom mode, a teacher's override takes precedence over the student's own (Feature 19) — this endpoint doesn't resolve that precedence itself, it just records whichever caller made the call; precedence is read-time logic elsewhere.

`POST /subtopics/:id/practice-problems/:problemId/attempt`
Records an attempt at a single practice problem (hint depth reached, final answer, correctness) and — since attempts are a real skill signal — optionally feeds Feature 8's mastery update the same way a quiz answer does.

**Schema gap — flagging, not drafting around it:** Feature 12 says *"Attempts can optionally feed `mastery_scores` the same way quiz answers do."* But there's no storage for practice-problem attempts anywhere in the schema — no `practice_attempts` table, and `QuizAttemptType` only has `module_quiz | final_project`, not a practice-problem variant. The `POST .../attempt` endpoint above has nothing to write to as the schema currently stands. Needs, before implementation, one of: a third `QuizAttemptType` enum value (reusing `quiz_attempts`, consistent with how F9 reused it for final projects) or a dedicated `practice_attempts` table if richer per-hint tracking is wanted — this is the same "reuse vs. dedicated table" fork the features doc already resolved once for F9, just not yet made for F12.

**Data model:** `practice_problems(id, subtopic_id, problem_text, hints_json, solution)`; `subtopics.practice_problems_override` (nullable boolean) — both already in the schema. Attempt storage per the gap above is not yet in the schema.
