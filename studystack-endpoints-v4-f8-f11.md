# StudyStack — Endpoint Stubs: F8 (Adaptive Mastery Engine), F11 (Visual Mastery Map)

Continues from `studystack-endpoints-v3-f7-f9.md`. Drafted together per the earlier scope note: F11 is a pure derived read over F8's data, and F11's "click a weak node" action routes directly into F8's review-content endpoint — the two are load-bearing on each other, not just adjacent.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## MasteryModule — F8 (Adaptive Mastery Engine & Spaced Repetition)

`GET /students/me/due-concepts`
Returns concepts where `next_review_at <= now`, computed by the periodic decay/scheduler job — surfaced when the student opens the app. This is a read over the scheduler's output, not a trigger for it; the decay recompute itself is an internal periodic job, not invoked by this call.

`GET /concepts/:id/review-content`
Returns this concept's re-angled review explanation for the authenticated student's `level`, generating it on cache miss (`concept_id + level + angle_variant` in `concept_review_content`) via `regenerateTutorialContent()`'s "different angle" path rather than replaying the cached first-pass `tutorial_content` from Feature 5/6. `angle_variant` selection/rotation is chosen server-side, not client-specified — same cross-student cache-sharing rationale as Feature 6.

*(Mastery score updates themselves have no standalone endpoint — they're written internally by Feature 7's `POST /modules/:id/quiz/submit`, per `concept_id`, not exposed as a direct client write. There is no client-facing way to set or override a `mastery_scores` row directly.)*

**Data model:** `mastery_scores(student_id, concept_id, score, last_reviewed_at, next_review_at)`; `concept_review_content(id, concept_id, level, angle_variant, explanation, generated_at)`.

---

## CourseModule — F11 (Visual Mastery Map)

`GET /courses/:id/mastery-map`
Returns every module/subtopic in the course as a node, colored from the authenticated student's `mastery_scores` (red/amber/green thresholds) joined through that course's `modules`/`subtopics`/`subtopic_concepts` — course-scoped, distinct from F15's cross-course `GET /students/me/concept-graph`. Concepts with no `mastery_scores` row yet render as a distinct "not started" state, not lumped in with "weak."

Each node's payload includes enough to route a click without a second round-trip: if the subtopic hasn't been completed yet, the client navigates to the subtopic view (`GET /subtopics/:id/tutorial`, F5/F6); if it's already been completed once and the concept is now due or decaying, the client instead calls F8's `GET /concepts/:id/review-content` — the map endpoint returns which of the two states applies per node so the client doesn't need to separately query `due-concepts` to decide.

**Data model:** None new — pure read/derived view over `mastery_scores` + `modules`/`subtopics`, as the features doc states.

**Refresh behavior (not a distinct endpoint):** The feature spec says this view "refreshes on every quiz submission and on each scheduled decay recompute, not just on page load." That's a client-side re-fetch-on-event behavior (or a future websocket/polling concern), not something this stub adds a separate endpoint for — flagging so it isn't silently dropped when this gets implemented.
