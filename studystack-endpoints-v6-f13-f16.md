# StudyStack — Endpoint Stubs: F13 (Export to External Tools), F16 (Verified Completion / Certificate)

Continues from `studystack-endpoints-v5-f10-f12.md`. Three open items surfaced checking these against the schema — flagged inline, none are drafted around silently.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## ExportModule — F13 (Export to External Tools)

`GET /modules/:id/export/anki`
Generates a `.apkg` (or CSV fallback) from the flashcard set tied to the module's subtopics, streamed as a file download.

`GET /modules/:id/export/pdf`
Renders the module's tutorials (explanation + diagrams + examples) into a formatted PDF, streamed as a file download.

`POST /modules/:id/export/notion`
Creates a page per module in the student's connected Notion workspace via Notion's API, mirroring the same tutorial content.

**Open item — flashcard storage is genuinely undecided, not just under-documented.** The features doc's own data-model line for F13 contradicts itself: it states *"No new storage"* in the same sentence it says flashcards *"could live as a derived field within `tutorial_content` or a dedicated `flashcards` table."* A dedicated table would obviously be new storage, so this wasn't actually resolved — it was left open and mis-stated as resolved. Checked the schema directly: `TutorialContent` has no flashcard-shaped field, and there's no `flashcards` table. `GET .../export/anki` has nothing to read from either way until this is decided. This needs the same explicit resolution the caching/override questions in earlier features got, not a default assumption here.

**Open item — no storage for the Notion connection itself.** F13 step 3 assumes *"if the student has connected a Notion account"* — that implies an OAuth token/workspace-id pair stored per user, but there's no such field on `User` and no separate connection table anywhere in the schema. `POST .../export/notion` has no way to check "is this student connected" or retrieve credentials to call Notion's API. Needs a `notion_connections(user_id, access_token, workspace_id, connected_at)`-shaped table (or equivalent) added before this endpoint is buildable — a connect/OAuth-callback endpoint pair would also be needed alongside it, not drafted here since it's a prerequisite this file doesn't currently cover.

**Data model:** `tutorial_content` (existing, read-only for this feature) — flashcard storage and Notion-connection storage both per the open items above, neither currently in the schema.

---

## CertificateModule — F16 (Verified Completion / Shareable Certificate)

`GET /courses/:id/certificate-eligibility`
Returns whether the authenticated student has completed everything required — derived as: every subtopic in the course has a `subtopic_completions` row for this student (scoped by `fork_id` if this is a forked/public course), plus a `quiz_attempts` row with `type = final_project`. A check the client uses to show/hide the certificate action, independent of whether a certificate has been issued yet.

`POST /courses/:id/certificate`
Issues a `certificates` row on course completion (`course_type = ai_generated` for every course today, per the schema's committed enum) and generates the shareable artifact. Idempotent per `(student_id, course_id)` — re-calling on an already-issued certificate returns the existing record rather than issuing a duplicate.

`GET /certificates/:verificationSlug`
Public, unauthenticated verification page — returns student name, course subject, completion date, level, and `course_type`, for anyone who clicks through from a shared link.

**Open item — paid-tier gating has no infrastructure to gate against.** F16 step 3 says to *"gate full certificate generation behind a paid tier if monetizing this directly"* — conditional in the spec itself, not a firm requirement, so this isn't drafted as an enforced gate here. Worth noting explicitly though: there is currently no tier/subscription/billing field anywhere in the schema (checked `User` and the full model list), so if this gate is turned on later it needs its own schema addition first — `POST /courses/:id/certificate` above assumes the ungated "free tier still shows completed status, full artifact available to everyone" behavior for now.

**Data model:** `certificates(id, student_id, course_id, issued_at, verification_slug, course_type)` — already in the schema, matches exactly.

---

## Schema fix (not scoped to F13/F16 alone) — completion tracking

Reviewing F16's eligibility check surfaced that no table anywhere tracked per-student subtopic/course completion — a gap silently assumed by F7 ("all subtopics... marked complete"), F11 (node click-routing), F14 ("on course completion, offer publish"), and F16 alike. Added `SubtopicCompletion(id, student_id, subtopic_id, fork_id, completed_at)` to the schema, unique on `(student_id, subtopic_id, fork_id)`, following the same optional `fork_id` pattern as `QuizAttempt` so forked/public-course completions don't collide across students.

This needs one new write endpoint not previously stubbed — `POST /subtopics/:id/complete`, marking the authenticated student's completion of a subtopic (idempotent on the unique constraint above) — belongs in `CourseModule` alongside `GET /subtopics/:id/tutorial`, not drafted in full here since it's a small addition to an already-stubbed module. Once added, F7's unlock check, F11's node state, and F14/F16's course-completion checks should all read from this table rather than each re-deriving "complete" independently.
