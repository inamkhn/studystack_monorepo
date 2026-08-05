# StudyStack — Endpoint Stubs: Auth, F1–3, F4–6, F4 (expanded), F15

Supersedes the previous endpoint-stub file. Two changes on reconsideration:

1. **F4 needed more than the admin review queue.** Concept resolution isn't just an admin-review surface — a `Concept` is a real resource other features read from (F15 depends on it directly), so it needs its own read endpoints, not just merge/dismiss actions.
2. **F15 (Cross-Course Knowledge Linking) was missing entirely from the last pass.** Adding it here. The three endpoints below are client-facing surfaces for the "skip/link-back" UI; the generation-time concept-mastery check is internal logic within Feature 4's module-generation pipeline, not a REST endpoint.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## AuthModule

`POST /auth/register`
Creates a self-serve account; unresolved `ageBracket` defaults to `unknown` (minor-safe), never `adult`.

`POST /auth/login`
Authenticates credentials and issues an access/refresh token pair.

`POST /auth/refresh`
Exchanges a valid refresh token for a new access token.

`POST /auth/logout`
Invalidates the current refresh token/session.

`GET /auth/me`
Returns the authenticated user's profile, role, and account-level settings.

`PATCH /auth/me`
Updates account-level settings, including `explanationStyle` (Feature 18's persona selection).

`PATCH /auth/me/age-bracket`
Soft, skippable birthdate-resolution step; resolves `ageBracket` to `adult` or leaves it minor-safe.

---

## CourseModule — F1–3 (Upload, Topic-Only, Intake)

`POST /courses/upload`
Accepts a syllabus/textbook/notes file and an optional `attestRights` boolean (Feature 1's early attestation — sets `publish_attestation_at` immediately if true, avoiding a surprise gate at publish time). Creates a `courses` row (`sourceType = upload`, `status = ingesting`) and enqueues the async ingestion job.

`PATCH /courses/:id/attest-rights`
Records rights attestation at any point — at upload time (if the checkbox was skipped) or later before publishing. Sets `publish_attestation_at = now()`. Idempotent; calling it again on an already-attested course is a no-op.

`GET /courses/:id/ingestion-status`
Polled during ingestion; returns current status plus incremental progress until `status = ready`.

`POST /courses/topic`
Accepts a topic string; creates a `courses` row (`sourceType = topic`) and triggers the research step before converging into module generation.

`PATCH /courses/:id/intake`
Records `goal` and `level` immediately after topic/upload submission, then triggers async module/subtopic structure generation (Feature 4). This is the point where both upload and topic-only paths converge — after intake, the course transitions from `intake_pending` through `structuring` to `ready`.

`PATCH /courses/:id/level`
Changes `level` mid-course; re-triggers generation only for not-yet-completed subtopics.

`PATCH /courses/:id/goal`
Changes `goal` mid-course; affects only future review-interval scheduling, never existing `tutorial_content`.

`PATCH /courses/:id/exam-date`
Sets or clears the optional `examDate`, shown only when `goal = exam_prep`.

---

## CourseModule — F4–6 (Structure, Tutorials, Caching)

`GET /courses/:id/structure`
Returns the generated module/subtopic outline for the sidebar/course map, including each subtopic's resolved `conceptId`s.

`GET /subtopics/:id/tutorial`
Returns cached `tutorial_content` for this subtopic (`subtopicId + level + styleBucket`), or triggers first-time synchronous generation on a cache miss.

*(F5 has no standalone endpoint — generation logic lives in `AiModule`, invoked internally by the tutorial-fetch endpoint above.)*

---

## CourseModule — F4 expanded (Concept Resolution)

`GET /concepts/:id`
Returns a single concept's detail — `canonicalName`, `subjectArea`, `aliases` — read by both the admin dedup screen and F15's cross-course surfaces.

`GET /concepts?search=`
Searches concepts by name/alias; used by the admin dedup screen to manually check for an existing match, and as a building block for F15.

`GET /admin/concept-review-candidates`
**Admin-only.** Lists `concept_review_candidates` rows with `status = pending_review` — the actionable concept-dedup queue.

`POST /admin/concept-review-candidates/:id/merge`
**Admin-only.** Confirms two concepts as duplicates and runs `mergeConcepts()` — reassigns FKs, combines mastery scores, soft-deletes the duplicate.

`POST /admin/concept-review-candidates/:id/dismiss`
**Admin-only.** Marks a flagged candidate as not a duplicate, closing the review item without merging.

---

## F15 — Cross-Course Knowledge Linking

All three endpoints below are **client-facing** — they power the "skip/link-back" UI shown when a student encounters a concept they've already mastered in another course. The generation-time check (Feature 4's step 4 — checking existing `mastery_scores` against resolved `concept_id`s during module generation) is internal logic within the `course` module's structure-generation pipeline, not a REST endpoint.

`GET /concepts/:id/linked-courses`
For the authenticated student, returns every one of their courses in which this concept appears — the "you've already covered this elsewhere" surface.

`GET /courses/:id/subtopics/:subtopicId/concept-links`
For a given subtopic, returns other courses/subtopics of the student's sharing its concept(s), plus their existing `mastery_scores` entry for that concept if one exists. Called by the client to render the "you already know this — skip or review?" prompt on a subtopic.

`GET /students/me/concept-graph`
Returns the authenticated student's full concept-mastery graph across all enrolled courses — the aggregate view powering any cross-course visualization, not scoped to a single course. Also serves as the data source for Feature 11's Visual Mastery Map.
