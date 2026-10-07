# Course Module — Overall Flow

Source: `studystack/apps/api/src/course/` (code) + deleted spec docs in git history
(`studystack-endpoints-v2.md`, `-v6`, `-v7` at commit `6f0ed4b^`).

## Module shell

Split into single-responsibility modules (2026-09 refactor): `course.module.ts`
imports `AuthModule, JobsModule` and provides `CourseService` (exported —
access oracle) + `CourseMaintenanceService`; controllers `CourseController`,
`AdminCourseMaintenanceController`. `concepts/` (top-level `ConceptsModule`:
`ConceptService` + `ConceptReviewService`), `tutorial/` (`TutorialModule`:
F6/F7), and `sharing/` (`SharingModule`: F14 + `ProvenanceGateService`,
exported for Marketplace reuse) each import `CourseModule` for access
checks — nothing points back, no cycles. All routes are unchanged.

## F1–F3: intake

- `POST /courses/upload (+attestRights)` → `course{sourceType:upload,
  status:ingesting, ingestionStage:queued}` + `sourceDocument{
  licenseStatus:user_uploaded_unknown}` + `ingest-course` BullMQ job
  (`jobId:ingest:<id>`). Early `attestRights=true` stamps
  `publishAttestationAt` immediately (avoids publish-time surprise).
- `POST /courses/uploads/presign → PUT S3 → POST /courses/uploads/:id/confirm`
  (new S3 flow, `STORAGE_DRIVER=s3` only): reserves
  `course{ingesting/awaiting-upload}` + `sourceDocument{awaiting-upload}`,
  returns 5-min virtual-hosted PUT URL; `confirm` verifies magic bytes via
  ranged GET, flips to `queued`, enqueues ingestion. Legacy multipart stays.
- `PATCH /courses/:id/attest-rights` — idempotent late attestation.
- `GET /courses/:id/ingestion-status` — poll `{status, failureReason?,
  language, progress:{stage, sourceDocuments, sourceChunks}}` until
  `ready/failed`.
- `DELETE /courses/:id` — owner hard delete; `409` if forks/purchases/
  classrooms/certificates exist.
- `POST /courses/topic` → `course{sourceType:topic, title=topic,
  status:ingesting}` + `research-course` job (stub worker today; designed
  for `sourceUrl + open_license` chunks converging into F4).
- `PATCH :id/intake{goal,level}` — records goal/level; code advances
  `intake_pending → structuring` + enqueues `structure-course` when parked.
  (Spec md says the transition should be driven by the internal
  intake-recorded-AND-ingestion-complete check, not the PATCH alone —
  divergence to reconcile.)
- `PATCH :id/level` (future-subtopics depth only, `levelChangedAt`),
  `PATCH :id/goal` (F8 scheduling only), `PATCH :id/exam-date`
  (only when `goal==exam_prep`).

## F4–F6: structure + tutorials + caching

- `GET /courses/:id/structure` — ordered modules → subtopics →
  resolved `conceptId`s (sidebar/course map).
- `GET /subtopics/:id/tutorial` — cache-first
  `tutorial_content[subtopicId + level(beginner default) +
  styleBucket(neutral default)]`; hit returns row, miss calls
  `AiService.generateTutorial` (501 stub today). F5 has no standalone
  endpoint by design — generation is internal.
- `PATCH /subtopics/:id/complete` — idempotent completion upsert feeding
  quiz/final gates.
- Concept resolution (F4-expanded): `GET /concepts/:id`,
  `GET /concepts?search=`, admin
  `GET /admin/concept-review-candidates`,
  `POST /admin/concept-review-candidates/:id/merge|dismiss`
  (merge reassigns FKs, mastery max-wins, soft-delete via `mergedIntoId`).

## F15: cross-course linking

- `GET /concepts/:id/linked-courses` — student's courses containing a concept.
- `GET /courses/:id/subtopics/:subtopicId/concept-links` — concepts +
  mastery + other locations (skip/link-back prompt).
- `GET /students/me/concept-graph` — full cross-course concept-mastery
  graph. Explicitly NOT the F11 mastery map (single-course, subtopic
  nodes — separate endpoint).

## F14: public sharing + ops

- `POST /courses/:id/publish` — copyright/provenance gate (full scan first
  time via `publish_gate_checked_at`, incremental after; blocks on
  `reused_from_upload + user_uploaded_unknown`; adult-only) →
  `visibility=public_shared`.
- `GET /courses/public` — no-auth browse (top 100).
- `POST /courses/:id/fork` — progress-only fork (`course_forks`, no content
  copy; attempts/mastery tagged `fork_id`).
- `POST /courses/:id/report` — moderation flag.
- `POST /admin/courses/reconcile` (re-enqueue stranded >30m) +
  `POST /admin/courses/cleanup-failed` (delete `failed` >14d).

## End-to-end

```
upload|topic → intake(goal+level) → structuring → ready
  → tutorial(cache-first) → complete → quiz/final (assessment)
  → publish/fork (F14) · concepts link across courses (F15)
```

Access split: writes `requireOwnedCourse` (404 on miss); reads
`getAccessibleCourseOrThrow` (owner OR fork). Public browse is isolated
from the authed controller to escape the class-level `JwtAuthGuard`.
