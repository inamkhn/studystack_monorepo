# StudyStack — Endpoint Stubs: F14 (Public Course Sharing), F17 (Course Marketplace)

Continues from `studystack-endpoints-v6-f13-f16.md`. One open design question and one required-but-unstated linkage surfaced checking these against the schema — both flagged inline.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## CourseModule — F14 (Public Course Sharing)

`POST /courses/:id/publish`
Runs the copyright/provenance gate — full scan if `publish_gate_checked_at` is null, incremental (rows generated since that timestamp) otherwise. Blocks with the specific offending subtopics if any `provenance = reused_from_upload` row has `license_status = user_uploaded_unknown`; on a clean pass, sets `visibility = public_shared`, `published_at = now()`, `publish_gate_checked_at = now()`. Unavailable to any account with `age_bracket != adult` (Feature 19), independent of the gate outcome.

`GET /courses/public`
Browsable/searchable index of `visibility = public_shared` courses, filterable by the subject/level/goal tags already stored on each course.

`POST /courses/:id/fork`
For a non-owner viewer of a public course who chooses to start "taking" it rather than just reading — creates a `course_forks` row. All subsequent `quiz_attempts`, `mastery_scores`, and `subtopic_completions` writes for this student against this course are tagged with the resulting `fork_id`, per Feature 14's existing "taking vs. reading" resolution. No `tutorial_content` is duplicated.

`POST /courses/:id/report`
Files a `course_reports` row (reason + reporter). Flagged-course removal from the public index pending review is a downstream admin action the features doc leaves unspecified beyond "gets pulled" — not detailed further here since the source doc doesn't detail it either.

**Data model:** `courses.visibility`, `.published_at`, `.publish_attestation_at`, `.publish_gate_checked_at`; `course_reports`; `course_forks` — all already in the schema, matches exactly.

---

## Marketplace/CourseModule — F17 (Course Marketplace)

`POST /courses/:id/marketplace/submit`
Creator submits a priced course for review — requires `role = creator` and `age_bracket = adult` (minors can't list paid courses). Runs the same underlying provenance-gate *scan* as `POST /courses/:id/publish` (shared internal logic, not a call to that endpoint) — blocks submission with the offending subtopics if anything trips it, same as a failed publish attempt. Unlike `publish`, a clean pass here does **not** set `visibility = public_shared`; visibility stays `private` (see the open question below) and instead creates a `marketplace_review_queue` row (`status = pending`, `sla_due_at = submitted_at + 72h`, `copyright_checklist_passed = false` — explicit at insert time, since the schema field is non-nullable with no default).

`GET /courses/marketplace`
Browsable/searchable index of courses with `marketplace_review_queue.status = approved`, distinct from `GET /courses/public` above.

`POST /courses/:id/purchase`
Runs the payment/checkout step (Stripe or similar), writes a `purchases` row. **Also creates a `course_forks` row for the buyer**, same as F14's "taking" action — the features doc doesn't say this explicitly for F17, but it has to be true for the same reason F19's original spec gap mattered: without a fork, a buyer's `quiz_attempts`/`mastery_scores`/`subtopic_completions` have nowhere to attach that isn't the shared course record. Treating this as required rather than optional, by direct analogy to the already-resolved F14 mechanism.

`GET /creators/me/payouts`
Creator's payout dashboard — aggregate `purchases` against their owned courses, net of the platform cut (`courses.creator_payout_pct`).

`GET /admin/marketplace-review-queue`
**Admin-only.** Lists `status = pending` rows — the actionable review queue, same shape as `GET /admin/concept-review-candidates` (F4).

`POST /admin/marketplace-review-queue/:id/approve`
**Admin-only.** Sets `copyright_checklist_passed = true` and `status = approved` together in the same call — the approval action *is* the checklist confirmation, not a separate prior step (the field starts `false` at submission, per above, precisely so a reviewer can't approve without this call explicitly flipping it).

`POST /admin/marketplace-review-queue/:id/reject`
**Admin-only.** Sets `status = rejected`.

**Open design question — not resolved by the feature spec, flagging rather than assuming:** `CourseVisibility` only has two values (`private | public_shared`) — there's no third state for "marketplace-listed." That leaves genuinely unclear whether an approved marketplace course sets `visibility = public_shared` (which would make its `tutorial_content` freely readable via `GET /courses/:id/structure` before purchase — contradicting the paid model) or stays `private` with marketplace listing/access governed entirely separately, via `marketplace_review_queue.status = approved` for discoverability and `purchases` existence for read-gating. The endpoints above assume the second (visibility stays `private`; access is purchase-gated, not visibility-gated) since it's the only version that doesn't leak paid content for free — but this needs an explicit decision recorded in the features doc, the same way the F9 storage-reuse question got one, not left implicit here.

**Data model:** `courses.price`, `.creator_payout_pct`; `purchases`; `marketplace_review_queue`; `users.role` (`admin` value) — all already in the schema, matches exactly.
