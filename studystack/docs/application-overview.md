# StudyStack — Application Overview

> What StudyStack is, how it works end to end, and the full feature surface
> (F1–F19) as implemented in this monorepo.
>
> Companion doc: [course-module-flow.md](./course-module-flow.md) for the
> deep course/ingestion pipeline walkthrough.

---

## 1. What is StudyStack?

StudyStack is an **AI-powered learning platform** where a student (or teacher,
creator, or school) turns any source material — a textbook PDF, lecture
notes, or just a topic name — into a **structured, interactive course**:
modules → subtopics → tutorials → quizzes → spaced-repetition review, with
mastery tracking that follows *concepts* across every course the student has
ever made.

The core promise:

| Input | StudyStack produces |
|---|---|
| Uploaded syllabus/textbook (PDF/DOCX) | Auto-ingested, chunked, embedded course grounded in *your* source |
| A bare topic ("Linear Algebra") | Web-researched course outline |
| Either of the above | Tutorials per subtopic, quizzes, practice problems, review schedules, certificates, exportable flashcards |

Everything is gated on **provenance**: content generated from an uploaded
copyrighted book cannot be published or sold until license status is
resolved (F14/F17 gate), and minors are protected by age-bracket guards
throughout (F18/F19).

---

## 2. Monorepo Layout

```
studystack/                       ← Turborepo + pnpm workspace
├── apps/
│   ├── api/                      ← NestJS 11 backend (this doc's focus)
│   └── web/                      ← Next.js frontend
├── packages/
│   ├── api-client/               ← typed client shared by web
│   ├── types/                    ← shared TS types
│   ├── config/                   ← shared config (eslint/ts/tailwind presets)
│   └── ui/                       ← shared React component library
└── docs/                         ← this file + module flow docs
```

### API tech stack

| Concern | Choice |
|---|---|
| Framework | NestJS 11 (TypeScript, strict) + Swagger |
| Database | PostgreSQL + **pgvector** via **Prisma 7** (`@prisma/adapter-pg`) |
| Jobs / queues | **BullMQ** on Redis (3 queues, priority tiers, exponential backoff) |
| Auth | Passport JWT (access) + DB-stored opaque refresh tokens (rotation + theft detection) |
| Rate limiting | `@nestjs/throttler` with Redis storage |
| Files | `StorageService` abstraction — local disk today, S3 presigned flow implemented (`STORAGE_DRIVER=s3`) |
| AI | LangChain/LangGraph behind Vercel AI Gateway (`AiModule`) |
| Emails | Resend (`MailModule`; logs instead of sends when key absent) |
| Validation | global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` + `transform`) |

### Prisma 7 specifics

- No `url` in the schema's datasource block — it lives in `prisma/prisma.config.ts`.
- `previewFeatures = ["postgresqlExtensions"]` enables `extensions = [vector]`,
  so `Unsupported("vector(768)")` embedding columns work natively.
- The pgvector table setup (`ivfflat` indexes, `source_chunks` RLS-style
  scoping) is applied via `prisma/vector-schema.sql`; see
  `studystack-vector-schema.sql` notes.

---

## 3. Architecture — How It Works

### 3.1 Big picture

```
Browser (Next.js)
   │  JWT access token (15 min) / refresh rotation
   ▼
NestJS API ──────────────► PostgreSQL (+ pgvector)  ← single source of truth
   │        │
   │        └────────────► Redis ──► BullMQ queues
   │                          INGESTION_QUEUE    (extract→chunk→embed)
   │                          RESEARCH_QUEUE     (topic → source chunks)
   │                          STRUCTURING_QUEUE  (chunks → modules/subtopics/concepts)
   │
   ├─► StorageService (disk | S3) for uploaded documents + figures
   └─► AiService (LLM gateway) for tutorials / review content / Q&A / grading
```

- **API processes** are stateless; all durable state is in Postgres.
- **Workers** live in `src/jobs/` (`ingestion.processor.ts`, structuring,
  research) and run in-process via BullMQ decorators.
- **Reconciliation** (`POST /admin/courses/reconcile`) repairs the DB↔queue
  drift that happens when Redis or a worker dies — every `queue.add` in the
  request path is wrapped in rollback + 503 so a course can never be created
  without its job.

### 3.2 The course lifecycle (the heart of the app)

```
upload | topic ──► ingesting ──► intake_pending ──► structuring ──► ready
 (F1/F2)          (extract,      (F3 goal+level      (F4 modules,       │
                    chunk,        recorded)           subtopics,        ▼
                    embed)                            concepts)   tutorials (F5/F6)
                                                                  quizzes (F9)
                                                                  mastery (F8/F11)
                                                                  publish/fork (F14)
```

1. **Ingestion (F1):** file is validated (magic bytes), hashed (SHA-256
   dedup), stored, then a worker extracts text → chunks → embeds (768-d
   vectors into `source_chunks`). Progress is polled via
   `GET /courses/:id/ingestion-status` (`stage` + document/chunk counts).
2. **Structuring (F4):** once intake (goal + level) is recorded, a worker
   uses the chunks (RAG) to generate the module/subtopic tree and resolve
   each subtopic to canonical **concepts** (pgvector similarity; ambiguous
   matches go to an admin review queue).
3. **Consumption (F6–F12):** tutorials are **cache-first** —
   `tutorial_content` keyed by `(subtopicId, level, styleBucket)`; a miss
   generates synchronously. Completions, quiz attempts, and practice
   attempts all feed `mastery_scores` per concept.
4. **Sharing (F14/F17):** publishing runs the **provenance gate** — any
   tutorial marked `reused_from_upload` while its source document has
   `licenseStatus = user_uploaded_unknown` blocks the publish until the
   uploader attests rights or the document license is resolved.

### 3.3 Access control model (applied uniformly)

| Tier | Mechanism |
|---|---|
| Public | `GET /courses/public`, marketplace browse — no auth (isolated controllers to escape class-level guards) |
| Owner-only writes | `CourseService.requireOwnedCourse` → 404 on miss (no existence leak) |
| Owner **or** fork reads | `CourseService.assertCourseAccess` (fork = enrollment record) |
| Minors | age-bracket guards: publishing/marketplace are adult-only; classroom content restricted by concept set |
| Admin | `RolesGuard` + `@Roles("admin")` for review queues and maintenance ops |

### 3.4 Auth & tokens (see §5 Auth and §6 walkthrough)

Dual-token: short-lived **access JWT** (15 min, payload only `{sub, role}`,
user re-fetched from DB per request) + **opaque refresh token** (7 days,
SHA-256 hash stored in `refresh_tokens`, rotated on every use; presenting a
revoked token's reuse triggers **theft detection → all user tokens revoked**).
Login uses a dummy-hash comparison to equalize timing for unknown emails.

---

## 4. API Module Map (post-refactor)

```
src/
├── auth/         JWT + refresh rotation, RBAC guards, profile, password flows
├── course/       F1–F4 lifecycle: upload (disk + S3), topic, intake, status,
│                 structure read, delete; maintenance (reconcile/cleanup/fail)
├── concepts/     F4 concept resolution + admin dedup review/merge + F15 links
├── tutorial/     F6 cache-first delivery + F7 completion tracking
├── sharing/      F14 publish/fork/report/browse + ProvenanceGateService (F17)
├── assessment/   F9 module quizzes + F7 submit gates + final project
├── mastery/      F8 spaced repetition (due concepts, review content) + F11 mastery map
├── qna/          F10 per-subtopic Q&A with semantic-cache lookup
├── export/       F13 Anki / PDF / Notion exports
├── certificate/  F16 eligibility, issuance, public verification by slug
├── marketplace/  F17 submit/review/approve/payouts (Stripe checkout stubbed)
├── classroom/    F19 teacher cohorts, invite/join, roster dashboards
├── ai/           LangGraph pipelines: generateTutorial, review content, Q&A
├── jobs/         BullMQ registration + ingestion/structuring/research workers
├── storage/      @Global disk/S3 abstraction        ├── prisma/  @Global client
├── mail/         @Global Resend email               └── common/  file validation, chunk-scope, utils
```

Dependency direction (no cycles):
`concepts/`, `tutorial/`, `sharing/` → `course/` (access oracle only);
`marketplace/` → `sharing/provenance-gate`; `course/` → `jobs/` (queues),
`storage/`, `prisma/`; `tutorial/` → `ai/`.

---

## 5. Features — Complete Catalog (F1–F19)

### F1 — Source upload & ingestion ✅
- `POST /courses/upload` (multipart, disk-streamed multer, ≤50 MB) or the S3
  flow: `POST /courses/uploads/presign` → browser `PUT` → `POST /courses/uploads/:id/confirm`
  (magic-byte verify, then enqueue).
- Abuse controls: 10 uploads/hour/user, 500 MB total quota, SHA-256 content
  dedup (same file twice = one ingestion cost).
- `PATCH /courses/:id/attest-rights` (idempotent rights attestation),
  `GET /courses/:id/ingestion-status` (stage + counts + failure reason),
  `DELETE /courses/:id` (hard delete; 409 if forks/purchases/classrooms/
  certificates reference it).
- Failure contract: unreadable file → `status=failed, failureReason`, every
  `source_document.extractionStatus=failed`; client stops polling.

### F2 — Topic-only course creation ✅
- `POST /courses/topic` → `RESEARCH_QUEUE` job (web-research path converges
  into the same structuring stage; research worker is a stub today).

### F3 — Intake (goal / level / exam date) ✅
- `PATCH /courses/:id/intake` — the convergence point: when both goal+level
  are present and ingestion is done, advances `intake_pending → structuring`
  and enqueues F4.
- `PATCH :id/level` (affects *future* subtopic depth only; `levelChangedAt`
  timestamp), `PATCH :id/goal`, `PATCH :id/exam-date` (valid only when
  `goal=exam_prep`; feeds F8 scheduling).

### F4 — Course structuring ✅ (+ concept resolution)
- `GET /courses/:id/structure` — ordered modules → subtopics → resolved
  concepts (sidebar / course map).
- Concepts are global, canonical, cross-course: `GET /concepts/:id`,
  `GET /concepts?search=` (name/alias today, embedding search lands with AI).
- Admin dedup queue: `GET /admin/concept-review-candidates`,
  `POST …/:id/merge` (6-step FK reassignment transaction — links, attempts,
  mastery max-wins merge, review content, soft-delete via `mergedIntoId`),
  `POST …/:id/dismiss`.

### F5 — Tutorial generation ✅ (pipeline) / ⚠️ AI stub
Internal-only by design — no standalone endpoint; invoked on F6 cache miss
(`AiService.generateTutorial`, currently a 501 stub until the gateway lands).

### F6 — Tutorial delivery (cache-first) ✅
- `GET /subtopics/:id/tutorial` — cache key
  `(subtopicId, level, styleBucket)`; hit returns the row, miss generates
  synchronously. Persona restyle rule: non-neutral variants require the
  neutral row first.

### F7 — Progress & completion ✅
- `PATCH /subtopics/:id/complete` — idempotent upsert into
  `subtopic_completions`; these rows gate quiz submission and the final
  project.

### F8 — Spaced repetition / review scheduling ✅
- `GET /students/me/due-concepts` — Leitner-style `nextReviewAt` from
  `mastery_scores` (goal + exam-date influence cadence).
- `GET /concepts/:id/review-content` — persona-flavored review explanations
  (`concept_review_content`, keyed by level + angle variant).

### F9 — Module quizzes ✅
- `GET /modules/:id/quiz` — generated/retrieved quiz (prerequisite:
  subtopic completions per the F7 gate).
- `POST /modules/:id/quiz/submit` — grading writes `quiz_attempts` (tagged
  `fork_id` where applicable) and updates concept mastery.

### F10 — Subtopic Q&A ✅
- `GET/POST /subtopics/:id/qna` — RAG over the subtopic's source chunks with
  a **semantic cache**: embedding match on the question (subtopic-scoped)
  short-circuits repeat LLM calls.

### F11 — Mastery map (per course) ✅
- `GET /courses/:id/mastery-map` — subtopic-level nodes colored by mastery.
  Explicitly distinct from F15's cross-course *concept* graph.

### F12 — Practice problems ✅
- `GET /subtopics/:id/practice-problems` (generation queue-backed),
  `POST /subtopics/:id/practice-problems/:problemId/attempt`,
  `PATCH /subtopics/:id/practice-problems-override`
  (auto `calcHeavy` flag from F4 controls defaults).

### F13 — Export ✅
- `GET /modules/:id/export/anki`, `GET …/export/pdf`,
  `POST …/export/notion` — `exports` rows track generation.

### F14 — Public sharing ✅
- `POST /courses/:id/publish` — **provenance gate** (full scan first time,
  incremental after `publish_gate_checked_at`) + adult-only guard →
  `visibility=public_shared`.
- `GET /courses/public` (no-auth browse), `POST /courses/:id/fork`
  (progress-only fork — a `course_forks` access record, **not** a content
  copy; concurrent-safe via P2002), `POST /courses/:id/report` (moderation).

### F15 — Cross-course concept linking ✅
- `GET /concepts/:id/linked-courses`,
  `GET /courses/:id/subtopics/:subtopicId/concept-links` (mastery + other
  locations of each concept → "you already learned this" prompts),
  `GET /students/me/concept-graph` (full concept-mastery graph).

### F16 — Certificates ✅
- `GET /courses/:id/certificate-eligibility`, `POST /courses/:id/certificate`
  (unique `verificationSlug`), `GET /certificates/:verificationSlug`
  (public verification, no auth).

### F17 — Marketplace ✅ (payment stubbed)
- `POST /courses/:id/marketplace/submit` — creator+adult only, positive
  price required, **reuses the same provenance gate** (shared service, not
  an HTTP hop); 72 h admin SLA stamped on the review row.
- `GET /courses/marketplace` (approved browse), `POST /courses/:id/purchase`
  (**Stripe checkout stubbed** — data model Purchase+CourseFork fully wired),
  `GET /creators/me/payouts` (revenue × payout %).
- Admin queue: `GET /admin/marketplace-review-queue`,
  `POST …/:id/approve|reject`.

### F18 — Explanation personas / age adaptation ✅
- `PATCH /auth/me` sets `explanationStyle` (persona bucket) and `birthDate`
  → server-derived `ageBracket` (`adult` / `minor_school_consented` /
  `unknown`); brackets gate publishing (F14/F17) and classroom content
  scoping (F19); persona feeds F6 cache key and F8 review content.

### F19 — Classrooms (teacher cohorts) ✅
- `POST /classrooms`, `POST /classrooms/:id/invite`, `POST …/join`
  (students join via fork-based enrollment — `classroom_students.fork_id`),
  `GET …/roster`, `GET …/dashboard` (per-student mastery rollup).
  Minor-safety: classroom content filtered by concept set.

### Auth (cross-cutting) ✅
`POST /auth/register|login|refresh|logout|forgot-password|reset-password`,
`PATCH /auth/change-password`, `GET|PATCH /auth/me` — with per-route rate
limits (register 3/min, login 5/min…), refresh rotation + theft detection,
timing-safe login, password-reset emails via Resend (logged in dev).

---

## 6. Feature Walkthroughs

The catalog above says *what* each feature exposes; this section tells the
story of each one — **who** uses it, **how** it flows step by step, and
**what protects** it from abuse, races, and bad data.

### F1 — Upload a real document, get a course backbone

*Who:* a student or teacher who owns the material — a textbook PDF, lecture
notes, a stack of past papers.

*How it works:*
1. They pick a file (≤50 MB). Either path works: legacy multipart
   (`POST /courses/upload`, streamed straight to disk — never buffered in
   memory) or the cloud path: ask the API for a presigned URL
   (`POST /courses/uploads/presign`), the browser `PUT`s directly to S3,
   then `POST /courses/uploads/:id/confirm` closes the loop.
2. Before anything is stored, the file is checked: magic bytes vs extension
   (a `.pdf` that's really an `.exe` dies here), then a streaming SHA-256
   hash is computed.
3. A `course` row (`status=ingesting`) and a `source_document` row are
   created, and an `ingest-course` job goes onto BullMQ. If Redis is down,
   the whole request rolls back — a course with no job can never exist.
4. The worker runs the pipeline `queued → extracting → chunking → embedding`:
   text out of the document (OCR fallback for scans), semantic chunks, then
   768-d vectors into `source_chunks`.
5. The client polls `GET /courses/:id/ingestion-status` and sees stage +
   document/chunk counts; on success the course moves to `intake_pending`
   (F3), on hard failure to `failed` with a human-readable `failureReason`
   so polling stops.

*What protects it:* 10 uploads/hour per user and a 500 MB lifetime quota
(computed from the DB, no Redis needed); duplicate content hashes are
rejected before any worker time is spent; rights attestation is recorded
up-front or late — but publishing will come back to this document's
`licenseStatus` (F14).

### F2 — No material? Just name a topic

*Who:* a curious learner ("I want to learn cryptography") with nothing to
upload.

*How it works:* `POST /courses/topic {topic}` creates a
`sourceType=topic` course and enqueues a `research-course` job. The research
worker (stub today; contract fully wired) is designed to gather
**open-licensed** web sources and push them into the same chunk/embed
surface F1 produces — so from structuring onward there is exactly one
pipeline, not two.

*What protects it:* researched chunks are tagged `open_license` at the
source-document level, so F14/F17's provenance gate can trust them without
user attestation; junk topics can't spam the queue because course creation
shares the same abuse controls.

### F3 — Tell the system how you learn

*Who:* anyone whose course just finished ingesting — the system now knows
*the material*, but not *the learner*.

*How it works:* a short interview: `PATCH /courses/:id/intake` records the
**goal** (exam prep / class / self-study / teaching) and **level**
(beginner → advanced). This is a *convergence point*, not just a form save:
structuring may not be done chunking yet, and chunking may not be done
waiting for intake — whichever side arrives last triggers
`intake_pending → structuring` and enqueues F4. Later tweaks: changing the
level (`PATCH :id/level`) only affects **future** subtopics (past work is
never re-written under you — `levelChangedAt` marks the line); the goal
influences review pacing (F8); `PATCH :id/exam-date` tightens that pacing
toward the date.

*What protects it:* exam-date is refused unless `goal=exam_prep` (a date
without a purpose is a bug waiting to happen); owner-only writes.

### F4 — Turn material into modules, subtopics, and canonical concepts

*Who:* runs for you; you see it in the course sidebar.

*How it works:* the structuring worker RAGs over the embedded chunks and
generates a module → subtopic tree calibrated to your level. Each subtopic
is then matched against the **global concept registry**: an exact
name/alias hit resolves instantly; a close-but-not-certain embedding match
creates a `concept_review_candidate` instead of guessing. Meanwhile the
worker flags calc-heavy modules once (F12) and marks each subtopic's
`generatedFrom` (upload-grounded vs web-grounded).

*What protects it:* the concept registry stays canonical — admins merge
duplicates in a 6-step transaction that reassigns every foreign key
(subtopic links, quiz attempts, practice attempts), **merges mastery scores
max-wins**, and soft-deletes the loser via `mergedIntoId` so history never
breaks. A wrong merge is recoverable; an uncontrolled fork of a concept is
not.

### F5 — Generate the actual lesson (internal)

*Who:* nobody calls this directly — by design.

*How it works:* when F6 finds no cached tutorial, it asks the AI pipeline,
which composes the tutorial **grounded in the subtopic's source chunks**
(your book, not the model's vibes), then stores it with a `provenance` tag:
`generated` (model's own explanation) or `reused_from_upload` (substantial
lift from the document). For minors, a scope-classifier node gates content
appropriateness before anything is returned.

*What protects it:* the provenance tag is the evidence trail the F14 gate
audits; generation is a seam with a 501 stub today, so no silent
vendor-lock is buried in the course pipeline.

### F6 — Instant tutorials, cached per persona

*Who:* the student tapping a subtopic in the sidebar.

*How it works:* `GET /subtopics/:id/tutorial` is a cache lookup on
`(subtopicId, level, styleBucket)` — the same subtopic is a different
document for a beginner than an advanced student, and different again for
your chosen persona (F18). A hit returns instantly; a miss generates
synchronously (F5) and stores the row. Every subsequent student at the same
(level, persona) rides the cache.

*What protects it:* the restyle rule — a non-neutral persona variant is
generated *from* the neutral row, never straight from source, so personas
change tone, never facts. Course access is verified through the owner-or-fork
check, so a random user can't prime the generation cache on someone's
private course.

### F7 — Honest progress tracking

*Who:* the student, at the end of each subtopic.

*How it works:* `PATCH /subtopics/:id/complete` upserts into
`subtopic_completions`. Idempotent — double-taps and flaky networks can't
double-count. These rows become the gatekeeper for everything downstream:
quizzes unlock per module (F9), the final project checks completion ratio,
certificate eligibility (F16) reads them.

*What protects it:* the web-verified flag distinguishes completions on
upload-grounded content from web-researched content — prerequisite credit
from a public fork is trusted according to its source.

### F8 — Spaced repetition that respects your exam

*Who:* the student who learned Fourier transforms in March and needs them
in May.

*How it works:* every graded interaction (quiz, practice, review) updates
`mastery_scores` per **concept** and schedules `nextReviewAt`.
`GET /students/me/due-concepts` returns today's queue; tapping one serves
`GET /concepts/:id/review-content` — short persona-flavored explanations
keyed by level and *angle variant* (see the same idea from three sides
before it's boring). Goal and exam date bend the cadence: exam_prep shortens
intervals and pulls due dates forward.

*What protects it:* review content is cached per `(concept, level, angle)`
globally, not per student — expensive generation is amortized across every
student who shares the concept, and the admin merge keeps that shared space
clean.

### F9 — Module quizzes with a prerequisite gate

*Who:* the student who finished all subtopics in a module.

*How it works:* `GET /modules/:id/quiz` returns (or generates) the quiz —
but only if F7 says the module's subtopics are complete; the gate exists
because attempts are graded evidence, and evidence from someone who skipped
the material is noise. `POST /modules/:id/quiz/submit` grades per-question,
writes a `quiz_attempt` tagged with the concept, and updates mastery.

*What protects it:* attempts made inside a classroom or fork are tagged
`fork_id` — the teacher's dashboard (F19) and the student's mastery both
read the same row, one source of truth; and the 6-step concept merge
reassigns attempts, so grading history survives dedup.

### F10 — Ask the subtopic anything (with a semantic cache)

*Who:* the stuck student, mid-tutorial.

*How it works:* `POST /subtopics/:id/qna` first embeds the question and
searches recent Q&A for the *same subtopic* for a semantically similar
question (paraphrase-tolerant, threshold-bounded). A cache hit returns the
prior answer; a miss runs RAG over the subtopic's source chunks, answers
with citations to your own material, and stores the pair for the next
student who asks "but why is the chain rule hiding here?" in different words.

*What protects it:* cache lookups are scoped by subtopic, never global —
an answer grounded in *your textbook's* notation can never leak as an
answer to a different book's convention.

### F11 — The mastery map (one course)

*Who:* the student deciding what to study next inside a single course.

*How it works:* `GET /courses/:id/mastery-map` renders the course's
subtopic nodes shaded by aggregate concept mastery — weak prerequisites
glow through their dependents, so "you can't do Laplace transforms yet
because *this* integral is rusty" becomes visible.

*What protects it:* deliberately separate from F15's cross-course concept
graph: same data, different question ("this course" vs "me as a learner"),
and neither endpoint can degrade the other.

### F12 — Practice problems, auto-calibrated per subtopic

*Who:* the student who read the tutorial and now must actually compute things.

*How it works:* `GET /subtopics/:id/practice-problems` serves generated
problems; attempts (`POST …/attempt`) grade and feed mastery like quizzes
do. The subtle part is the `calcHeavy` flag — decided **once** at module
generation time (F4) when the source material is math/physics-flavored.
Calc-heavy subtopics default to more problems; if the auto-call is wrong for
you, `PATCH /subtopics/:id/practice-problems-override` flips it per subtopic.

*What protects it:* the flag is stamped once at generation and never
silently recomputed, so problem volume stays stable for a cohort studying
the same material.

### F13 — Take it with you (Anki / PDF / Notion)

*Who:* the student whose real revision happens offline or in another app.

*How it works:* per module: `GET /modules/:id/export/anki` (TSV deck),
`GET …/export/pdf` (printable summary), `POST …/export/notion` (block
payload). Each run creates an `exports` row — so we can see what formats
people actually want, and generation failures are auditable.

*What protects it:* exports read only from cached tutorials/structure, so
exporting doesn't become a back-door to trigger paid AI generation.

### F14 — Publish, fork, report — the sharing layer

*Who:* a learner who built something genuinely good and wants it public.

*How it works:* `POST /courses/:id/publish` walks a gauntlet: adult account
→ course `ready` → **provenance gate**. The gate asks one question: *did
any published tutorial lean on uploaded material whose license nobody
clarified?* Concretely: any `reused_from_upload` content + a source document
still marked `user_uploaded_unknown` = publish refused, naming the exact
offending subtopics. First run is a full scan; later runs are incremental
(rows generated since `publish_gate_checked_at`), so re-publishing is cheap.
Publishing sets `visibility=public_shared`; `GET /courses/public` is the
no-auth storefront; `POST /courses/:id/fork` lets a learner enroll — and
here's the deliberate design: **a fork copies nothing**. It's an access
record; the "copy" shares your modules/subtopics/tutorials, and the
forker's attempts and mastery are tagged to the fork. `POST /courses/:id/report`
flags bad listings for moderation.

*What protects it:* the whole feature is the protection — copyright
liability is stopped at the gate, not policed after the fact; forks mean a
published course's tutorial cache serves thousands of students with zero
storage duplication, and the owner's `DELETE` is blocked (409) the moment
learners depend on it.

### F15 — Concepts that connect your whole learning life

*Who:* the student who hit "eigenvalue problems" in three different courses
and should feel that.

*How it works:* three read-only surfaces. On a subtopic,
`GET …/concept-links` shows each concept, *your mastery of it*, and every
other place you've met it — the UI prompt "you already learned this, skip
or review?". Per concept, `GET /concepts/:id/linked-courses` lists your
courses containing it. Globally, `GET /students/me/concept-graph` is the
map of everything you know, by concept, across courses.

*What protects it:* this only works because F4 made concepts canonical —
the links surface is a pure reader of that registry, which is why the admin
merge exists at all.

### F16 — Certificates people can verify

*Who:* the finisher.

*How it works:* `GET /courses/:id/certificate-eligibility` evaluates the
thresholds (completion ratio via F7, quiz performance, final project); when
earned, `POST /courses/:id/certificate` mints a row with a random
`verificationSlug`. Anyone, anywhere, can check
`GET /certificates/:verificationSlug` — no auth, no account, just the
truth.

*What protects it:* the slug is unguessable and the verify endpoint exposes
the minimum (who, what, when) — no grades, no personal data; the owner's
delete is blocked while certificates are issued (F1 §4.3 dependents check).

### F17 — The marketplace (paid courses)

*Who:* creators monetizing expertise; buyers wanting polished material.

*How it works:* a creator (`role=creator`, adult, course `ready`, price > 0)
submits via `POST /courses/:id/marketplace/submit` — running the *same*
provenance gate service F14 uses (shared code, not an HTTP hop). The review
row carries a 72-hour admin SLA timestamp. Admins approve/reject in the
queue; approved courses appear in `GET /courses/marketplace`. Purchase is
fully modeled (Purchase + CourseFork created atomically, payouts computed
from `creatorPayoutPct`) but **checkout itself throws
`NotImplementedException` until Stripe lands** — an honest stub rather than
a fake success. `GET /creators/me/payouts` is the earnings dashboard.

*What protects it:* minors can't sell; concurrent duplicate submissions are
P2002-guarded; buying grants exactly the fork F14 uses, so marketplace and
free sharing share one enrollment primitive.

### F18 — Personas & age-appropriate explanations

*Who:* everyone — silently shaping every explanation they read.

*How it works:* `PATCH /auth/me` stores an `explanationStyle` (the persona
bucket in every F6 cache key) and, if provided, a `birthDate` from which the
**server** derives `ageBracket` (never trust a client-sent age). Adult is
assumed only when the derivation says so; the bracket gates publishing
(F14), marketplace selling and buying (F17), and classroom content scoping
(F19). Generation pipelines route minors through the scope-classifier node
before content is returned.

*What protects it:* age is derived, not declared — the only input a student
could forge is their birth date, which the derived-bracket + school-consent
tier handles; and personas change tone only, never factual grounding.

### F19 — Classrooms for teachers and schools

*Who:* a teacher running 30 students through the same course.

*How it works:* `POST /classrooms` (course must be ready); students join by
invite code (`POST /classrooms/:id/invite`, `POST …/join`). Joining creates a
fork (shared enrollment primitive again) recorded in `classroom_students`.
The teacher's `GET …/roster` and `GET …/dashboard` aggregate each student's
completions and mastery — the same data F11/F15 use, cut by cohort.

*What protects it:* if any member's bracket is `minor_school_consented`,
classroom content is filtered by an allowed concept set; dashboards show
learning signals, never personal data; and the teacher's invite is the only
door in.

### Cross-cutting — Auth & sessions

*Who:* everyone, first.

*How it works:* login issues a 15-minute JWT (carrying only `{sub, role}` —
the user row is re-read from the DB on every request, so a role change or
deactivation is instant) plus an opaque 7-day refresh token, stored only as
a SHA-256 hash. Every refresh **rotates**: the old token is atomically
revoked and linked to its replacement (`replacedByTokenId`). Password reset
emails a single-use hashed token (logged, not mailed, when `RESEND_API_KEY`
is unset in dev).

*What protects it:* presenting an already-revoked refresh token = theft
signal → **all** of that user's tokens are revoked and they're logged out
everywhere. Login compares against a dummy hash when the email is unknown,
so response timing doesn't leak who has an account. Register/login/forgot
routes carry per-route Redis-backed rate limits (3–10/min).

---

## 7. Ops Endpoints (admin)

| Route | Purpose |
|---|---|
| `POST /admin/courses/reconcile` | Re-enqueue courses stranded in `ingesting/structuring` >30 min, or `intake_pending` with goal+level set (jobs still live in queues are skipped; idempotent) |
| `POST /admin/courses/cleanup-failed` | TTL sweep — hard-delete `failed` courses older than 14 days (files included) |
| `GET/POST /admin/concept-review-candidates…` | Concept dedup queue (F4) |
| `GET/POST /admin/marketplace-review-queue…` | Marketplace approval (F17) |

## 8. Data Model Highlights

Full schema: `apps/api/prisma/schema.prisma` (~560 lines). Load-bearing
pieces:

- `Course` — `sourceType(upload|topic)`, `status` lifecycle, `visibility`,
  intake fields (`goal`, `level`, `examDate`, `levelChangedAt`), publishing
  fields (`publishedAt`, `publishGateCheckedAt`, `price`, `stripeProductId/
  PriceId`, `creatorPayoutPct`), `language`.
- `SourceDocument` / `SourceChunk` — extraction state, `licenseStatus`,
  `contentHash`, `sizeBytes`; chunks carry `vector(768)` embeddings.
- `Module` / `Subtopic` → `SubtopicConcept` → `Concept` (canonical,
  `mergedIntoId` soft-dedup, `matchStatus`, `aliases[]`).
- `TutorialContent` — unique `(subtopicId, level, styleBucket)` +
  `provenance(generated|reused_from_upload)` — the F14 gate's evidence trail.
- `MasteryScore` (unique student+concept), `SubtopicCompletion`,
  `QuizAttempt`/`ModuleQuiz`, `PracticeProblem(+Attempt)`,
  `ConceptReviewContent`, `QnaMessage` (with question embedding cache).
- `CourseFork` (unique original+student) — the enrollment primitive for
  F14/F17/F19; attempts/mastery tagged with `forkId`.
- `CourseReport`, `Export`, `Certificate`, `Purchase`,
  `MarketplaceReviewQueue`, `Classroom`/`ClassroomStudent`,
  `ConceptReviewCandidate`, `RefreshToken` (hashed, `revokedAt`,
  `replacedByTokenId`).

## 9. Current Implementation Status

| Area | State |
|---|---|
| Auth (incl. reset/change password, rotation, theft detection, throttling) | ✅ production-shaped |
| F1–F4 course lifecycle, queues, reconciliation, quotas | ✅ |
| F6/F7 cache-first tutorial delivery + completions | ✅ (delivery), ⚠️ F5 generation is a 501 stub until the AI gateway is keyed |
| F8–F13 mastery/review/quiz/Q&A/practice/export | ✅ endpoints + services (LLM-dependent paths stubbed) |
| F14/F15/F16 sharing, linking, certificates | ✅ |
| F17 marketplace | ✅ except Stripe checkout (throws `NotImplementedError` by design until step 7) |
| F18/F19 personas, age gates, classrooms | ✅ |
| Research worker (F2) | ⚠️ stub — contract wired, real web research pending |
| Concept-resolution single-writer conflict (AI vs structuring worker writing `subtopic_concepts`) | ⚠️ known architectural item |

## 10. Running Locally

```bash
# prerequisites: Postgres (with pgvector), Redis
cd studystack
pnpm install
pnpm --filter api prisma generate     # Prisma 7 client (reads prisma/prisma.config.ts)
# apply prisma/vector-schema.sql for pgvector tables/indexes, then:
pnpm dev                              # turbo: api :3001 + web :3000
```

Key env (`apps/api/.env`, see `.env.example`): `DATABASE_URL`, `JWT_SECRET`,
`JWT_EXPIRES_IN`, `REDIS_URL`, `STORAGE_DRIVER(disk|s3)` + S3 creds,
`AI_GATEWAY_API_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`.

Without Redis the API still boots (queues retry); BullMQ-dependent flows
need it up. Without `RESEND_API_KEY`, emails are logged, not sent.
