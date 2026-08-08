# StudyStack — Endpoint Stubs: F18 (Explain-It-Your-Way Personas), F19 (Teacher / Classroom Mode)

Continues from `studystack-endpoints-v7-f14-f17.md`. Closes out the endpoint pass — every feature (1–19) now has either a stub or an explicit "no new endpoint needed" note.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## F18 (Explain-It-Your-Way Personas) — no new endpoint

Fully covered by `PATCH /auth/me` (already stubbed in `studystack-endpoints-v2.md`), which explicitly lists `explanationStyle` as one of its account-level settings. `ExplanationStyle` is a closed enum (`neutral | sports | pop_culture | historical | cooking | sci_fi`, per the schema comment *"Closed enum per Feature 18 (not free text)"*), so the client hardcodes the picker options rather than needing a `GET /explanation-styles` listing endpoint. Nothing else in F18 is client-facing — the cache-fragmentation resolution (`style_bucket`, shared "neutral" base + per-style restyle layer) is internal to Feature 5/6's generation pipeline, not a separate surface.

---

## ClassroomModule — F19 (Teacher / Classroom Mode)

`POST /classrooms`
Teacher creates a classroom tied to an already-created course (built via the Upload Path, Feature 1). Requires `role = teacher`. **`consentOnFile` and `consentDocumentUrl` are required, non-optional inputs to this call, not left to the schema's `@default(false)`** — the feature spec states *"classroom creation requires the inviting teacher/institution to attest that consent is handled"*, meaning the gate belongs at creation time. The schema default exists so the column has a safe fallback if bypassed some other way, not as an implicit "attest later" path — this endpoint must reject a create attempt that doesn't affirmatively set consent, or the spec's stated requirement isn't actually enforced anywhere.

`POST /classrooms/:id/invite`
Teacher-only. Generates a class code (or accepts a roster upload) for student invitation.

`POST /classrooms/:id/join`
Student joins via class code. Creates a `classroom_students` row and a `course_forks` row (`original_course_id` = the classroom's course, `student_id` = joiner) in the same operation, setting `classroom_students.fork_id` to the new fork's id — mirroring F14's fork-on-"taking" mechanism rather than a second bespoke system. Sets `age_bracket = minor_school_consented` only if the joining account is brand new (created through this invite flow) or currently `unknown` — **never downgrades an already-`adult` account**. `age_bracket` gates publish/marketplace/Q&A-scope behavior app-wide, not just within this classroom, so silently overwriting an already-verified adult (e.g. an adult continuing-ed student, a TA) would incorrectly strip real permissions elsewhere in the app. An earlier draft of this stub said this overwrite happened "regardless of whatever value it held before" — that was wrong and has been corrected.

`GET /classrooms/:id/roster`
Teacher-only. Lists enrolled students (name, joined-at) — distinct from the dashboard below, which is anonymized by default; the spec leaves it a deliberate, disclosed decision whether a teacher can ever see individual students' specific wrong answers, so roster membership and performance data are kept as separate reads rather than one endpoint that always exposes both.

`GET /classrooms/:id/dashboard`
Teacher-only. Aggregated, anonymized-per-student, rolled-up-per-concept view — e.g. "62% of the class is weak on Elasticity." Two different join paths, per the earlier F19 correction: `quiz_attempts` joins to `classroom_students` via `fork_id`; `mastery_scores` joins via `student_id` directly, scoped to the classroom's course by filtering to the `concept_id`s reachable through `modules → subtopics → subtopic_concepts` (not by fork, since `mastery_scores` has neither a `fork_id` nor a `course_id` column — it's deliberately global per student+concept for Feature 15). `subtopic_completions` (added while reviewing F16) isn't mentioned in the feature spec's dashboard description and isn't drafted into this endpoint here — a natural future extension for a "% of class finished module X" view, but adding it wasn't specified, so it's called out rather than silently included.

**Data model:** `classrooms(id, teacher_id, course_id, consent_on_file, consent_document_url)`, `classroom_students(classroom_id, student_id, fork_id)`, `users.age_bracket` — all already in the schema, matches exactly.

**Enforcement, not drafted as separate endpoints — internal to existing ones per Feature 19's compliance section:** any account with `age_bracket != adult` gets, automatically rather than as teacher configuration: a hard topic-scope classifier on `POST /subtopics/:id/qna` (F10) with refuse-and-redirect on a miss; `POST /courses/:id/publish` and `POST /courses/:id/marketplace/submit` (F14/F17) unavailable outright; and exclusion from any B2B-facing PostHog analytics stream. These are behavior changes inside already-stubbed endpoints based on the caller's `age_bracket`, not new routes.
