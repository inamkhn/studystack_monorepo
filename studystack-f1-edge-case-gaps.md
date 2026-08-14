# StudyStack — F1 (Upload Path) Edge-Case Audit & Gap Analysis

Audit of Feature 1 (Upload Path) against three sources of truth:

- `studystack-features-explained-resolved.md` — §1 "Upload Path" spec
- `studystack-llm-handling.md` — guardrail requirements that apply to ingestion
- Current implementation: `apps/api/src/course/course.controller.ts`, `course.service.ts`, `dto/upload-course.dto.ts`, `apps/api/src/jobs/ingestion.processor.ts`, `prisma/schema.prisma`, `prisma/vector-schema.sql`

**Verdict:** the producer side (upload → persist → enqueue → poll) is solid; the consumer side (extraction pipeline) is a stub; and several failure contracts, schema columns, and security guardrails required by the specs do not exist yet.

---

## 1. What's already covered ✅

| Spec requirement | Status | Evidence |
|---|---|---|
| Course row with `source_type=upload`, `status=ingesting` | ✅ | `createUploadCourse()` |
| Optional early rights attestation at upload time | ✅ | `attestRights` multipart boolean, correctly coerced in `UploadCourseDto` (`"false"` is not naively truthy-coerced) |
| `license_status = user_uploaded_unknown` safe default | ✅ | `SourceDocument` creation; never defaults more permissive |
| Priority-1 ingestion job, idempotent `jobId: ingest:<courseId>` | ✅ | `JOB_PRIORITY.newCourseIngestion = 1` |
| Orphan-course cleanup if DB persistence fails | ✅ | catch deletes the course row |
| Filename sanitization, courseId-prefixed (no collisions) | ✅ | `[\\/:*?"<>|]` → `_` |
| `apps/api/uploads/` gitignored | ✅ | root `.gitignore` |
| Progress polling with source document / chunk counts | ✅ | `GET /courses/:id/ingestion-status`, owner-or-fork access |
| Owner-only mutation, owner-or-fork reads | ✅ | `requireOwnedCourse` / `getAccessibleCourseOrThrow` |
| Late attestation endpoint, idempotent | ✅ | `PATCH /courses/:id/attest-rights` |

---

## 2. Missing — the spec's three explicit edge cases 🔴

### 2.1 Corrupted/unreadable file → "surface a clear error; don't create an empty course silently"

**✅ RESOLVED (2026-05-13).** Implemented across four layers:

- **Schema:** `Course.failureReason String?` added (migration `20260813100000_add_course_failure_reason`, applied via `db execute` + `migrate resolve` to avoid drift-reset from the hand-applied HNSW indexes)
- **Upload-time validation:** `src/common/utils/file-validation.ts` — extension must be `.pdf/.docx/.txt/.md` AND magic bytes must agree (`%PDF-`, `PK\x03\x04` zip container, text heuristic). Mismatch → `415 UnsupportedMediaTypeException`; no course row is created
- **Worker-side integrity check:** `IngestionProcessor` re-reads the first 8 KB of every source document before the pipeline; missing/empty/unrecognizable file marks the course `failed` + `failureReason`, stamps all `SourceDocument.extractionStatus = "failed"`, and does NOT retry the job
- **Status endpoint:** `GET /ingestion-status` returns `failureReason` when present so clients stop polling and can surface the reason
- `CourseService.failCourseIngestion()` exists as the reusable failure contract (the processor mirrors it inline to avoid a JobsModule ↔ CourseModule cycle)

### 2.2 Large uploads (400+ pages) → "process in chunks, don't block the UI"

**✅ RESOLVED (2026-05-13) — infra layer; chunk-splitting itself lands with the pipeline (item #5).**

- **Disk streaming:** `FileInterceptor` now uses multer `diskStorage` (temp `<uuid>.<ext>` in `uploads/`) — uploads never sit in the heap, so 10 concurrent 50 MB uploads no longer cost ~500 MB of RAM. `multer@^2.2.0` added as a direct dependency (aligned with `@nestjs/platform-express`; 1.x has known vulns)
- **Rename, not copy:** once the course row exists the temp file is `rename`d to `<courseId>-<name>` (same volume, cheap); on failure both the temp file and the course row are cleaned up
- **Per-stage progress:** `Course.ingestionStage` added (`queued → extracting → chunking → embedding`). Upload sets `queued`, worker sets `extracting` on pickup; `GET /ingestion-status` returns `progress.stage` alongside the counts. `chunking`/`embedding` transitions land with the real pipeline
- **Size tracking:** `SourceDocument.fileSizeBytes` captured at upload (migration `20260813110000_add_ingestion_progress_fields`)
- **Validation moved to disk:** `validateUploadFilePath()` sniffs the first 8 KB of the streamed file (shared `readFileHead` util, also reused by the worker) — same 415 contract as before

Remaining for the pipeline step: ~~actual page-chunked processing of 400+ page documents~~ — **done in Phase A (2026-08-13):** per-page PDF extraction, batched chunk persistence (200 rows/batch), capped OCR (25 pages) and per-document progress events keep large documents non-blocking.

### 2.3 Non-English source → "detect language, keep generated content in the source's language"

**✅ RESOLVED (2026-05-13) — detection + persistence in place; PDF/DOCX detection lands with extraction.**

- **Schema:** `Course.language String?` added (BCP-47 code; migration `20260813120000_add_course_language`)
- **Detector:** `src/common/utils/language-detection.ts` — zero-dependency, two layers: Unicode script ranges (ja, ko, zh, ru, ar, hi, el, he, th; ≥ 30% of letters wins) + distinctive-stopword scoring for Latin languages (en/es/fr/de/pt/it, needs ≥ 2 hits and an outright winner). Smoke-tested 9 languages, all correct
- **Conservative by design:** returns `null` when undetermined — callers must treat unknown as unknown, never default to English (a wrong guess would poison every downstream generation prompt)
- **Wiring:** plain-text uploads (`.txt`/`.md`) are detected at upload from the first 64 KB and stored on the course; PDF/DOCX stay `null` until the AiModule pipeline extracts text (no text to read today)
- **Surfaced:** `GET /ingestion-status` returns `language`

Remaining for the pipeline step: ~~detection from extracted PDF/DOCX text~~ — **done in Phase A (2026-08-13):** the worker detects language from extracted text (digital text preferred over OCR text) and fills `Course.language` when it was still null. Still open: feeding `language` into every generation prompt (needs the generation pipeline).

---

## 3. Missing — pipeline gaps (spec steps 3–5) 🟢 Phase A/B/C code-complete — live LLM verification awaits Gateway key

**✅ Phase A RESOLVED (2026-08-13)** — the real extraction + chunking pipeline replaced the stub:

- **New module** `src/ai/pipeline/`: `extract-text.ts` (Markdown headings → sections, paragraph fallback), `extract-docx.ts` (mammoth → semantic HTML → h1–h6 sections), `extract-pdf.ts` (unpdf per-page text; scanned pages detected by thin text layer → embedded-image extraction → dependency-free PNG encoder → **Tesseract.js** OCR, capped at 25 pages), `chunker.ts` (~600-word sentence-boundary chunks with 60-word overlap, heading prefix on first chunk), `types.ts`, barrel `index.ts`
- **Deps:** `unpdf` (serverless pdfjs), `mammoth`, `tesseract.js` (pure WASM, $0; chosen over hosted OCR — user decision; provider interface stays swappable)
- **`IngestionProcessor` rewritten:** extracting → chunking → convergence; per-document `extractionStatus` lifecycle (`extracting → done/failed`), one bad document no longer sinks the course, zero-content extraction still fails it (failure contract intact); retry-safe (`deleteMany` before insert); batched `createMany` (200)
- **`needs_research_fill`:** the column already existed in schema + init migration (this doc previously said it was missing — corrected); headed sections with < 20 body words are now flagged
- **Language (2.3):** detected from extracted text for PDF/DOCX too
- **F3 convergence wired both directions:** ingestion-complete side parks the course at `intake_pending` (no goal+level) or `structuring` (`awaiting_structuring` stage); `PATCH intake` advances an `intake_pending` course to `structuring`
- **Verified:** 9 unit smoke tests (`scripts/smoke-pipeline.mjs`) + DB end-to-end run (`scripts/e2e-ingestion.mjs`) — PDF + Markdown course → 3 chunks, 1 flagged, language `en`, both docs `done`, progress events emitted

**🟠 Phase B code-complete (2026-08-13)** — embeddings + F4 structuring built and compile-clean; final frontier-call verification awaits a real `AI_GATEWAY_API_KEY`:

- **Gateway client** `src/ai/gateway.ts` — Vercel AI Gateway OpenAI-compatible endpoint (`AI_GATEWAY_BASE_URL`/`AI_GATEWAY_API_KEY`); models are config strings (`AI_MODEL_FRONTIER` default `google/gemini-2.5-pro`, `AI_MODEL_EMBEDDING` default `google/gemini-embedding-001`); bounded retries (`GATEWAY_MAX_RETRIES = 2`)
- **Contract** `@studystack/types` `CourseStructureSchema` (Zod): subjectArea → modules 1–12 → subtopics 1–10 → concepts 1–12 with canonicalName/aliases caps
- **Embedder** `src/ai/pipeline/embedder.ts` — Matryoshka policy: truncate wider vectors to 768 + L2-normalize; idempotent pgvector writes (`WHERE embedding IS NULL`, 50-row transactions); `embedConceptRows` for concept vectors
- **Structuring** `src/ai/pipeline/structuring.ts` — one bounded frontier call: 32k-char input budget, head-weighted chunk sampling (≤40 chunks × 1.5k chars), injection-hygiene system prompt (source text wrapped in `<untrusted_source_documents>` with explicit data-not-instructions rule), maxTokens 4096, double validation (`withStructuredOutput` + `CourseStructureSchema.parse`)
- **Worker** `src/jobs/structuring.processor.ts` — `STRUCTURING_QUEUE`; retry-safe (wipes prior structure), case-insensitive canonical-name concept dedup against the global concept table, embeds new concepts, fills `course.topic` from `subjectArea` for uploads, flips course to `ready`; BullMQ attempts 2 + exponential 15 s backoff; F1 failure contract only after retries exhaust
- **Ingestion embedding stage:** recoverable by design — Gateway failure warns and continues (course still converges); extraction failures stay fatal
- **F3 convergence:** ingestion-complete with intake recorded → `structuring` status + structuring enqueue (`jobId structure:<courseId>`)
- **Verified:** `scripts/e2e-phaseb.mjs` — **PARTIAL PASS** without key (ingestion → `structuring`, correct job options, embedding skip recoverable). With key: asserts 768-dim chunk embeddings + frontier structure → `ready`

**✅ Phase C RESOLVED (2026-08-13)** — figures + research-fill backfill, both verified key-free:

- **Figure persistence:** extractors now return `images[]` alongside sections — PDF digital pages via `extractImages` (tiny <64px icons filtered, capped at 20/doc, rasters re-encoded to PNG), DOCX via mammoth `convertImage` (PNG/JPEG sniffed, dimensions parsed from headers, markers attribute each figure to its section during splitting). `IngestionProcessor` saves them under `uploads/assets/<courseId>/` (`assets.ts`, wiped on re-run for retry safety) and links each figure into `source_chunks.metadata.images` of its section's chunks. Per-image failures warn and never sink a document
- **Backfill producer** `src/jobs/backfill.service.ts` — fired by `StructuringProcessor` right after the course flips `ready`: every `needsResearchFill` chunk is fuzzy-matched to a structure subtopic (normalized exact match, then bidirectional containment), one priority-2 job per matched subtopic on the existing `research` queue (`jobId backfill:<subtopicId>`, attempts 2, exponential 30 s backoff); unmatched flags are logged and skipped
- **Backfill worker** `src/jobs/backfill.processor.ts` — consolidated `RESEARCH_QUEUE` handler (dispatches by job name; absorbed the old F2 stub): bounded frontier call per subtopic (`backfill.ts`, injection hygiene + 2k-char anchor budget), writes `tutorial_content` under the F6 cache key `(subtopic, level, "neutral")`, provenance `generated`, idempotent. Backfill failure never un-readies a course — F6's on-demand tutorial generation stays the fallback
- **Verified:** smoke suite 15/15 (figure capture to real PNG, tiny-image filtering, matcher unit tests) + DB E2E — figure on disk + linked in chunk metadata, thin section flagged, producer enqueued exactly one priority-2 job with the right `jobId`

Remaining pipeline items:

| Spec step | Status |
|---|---|
| Content-type splitting (text/DOCX/PDF + scanned-page OCR) | ✅ Phase A |
| Math-OCR routing | ✖️ dropped by decision — general free OCR (Tesseract) covers scanned pages; math-specific OCR not needed |
| Images/diagrams kept linked to their source section | ✅ Phase C — PDF + DOCX figures persisted + section-linked; `.md` image refs stay unresolved (relative paths in uploads aren't portable) |
| `needs_research_fill` flagging | ✅ Phase A (column existed; flagging implemented) |
| Chunking into `source_chunks` + embedding | ✅ Phase A chunking; ✅ Phase B embedding code (real-key run pending) |
| Priority-2 backfill enqueue | ✅ Phase C — producer + worker built and verified; the worker's LLM call activates with the Gateway key |
| `ingesting → ready` transition | 🟠 Phase B code-complete — structuring worker → `ready`; needs Gateway key for live verification |

---

## 4. Missing — real-world edge cases the spec didn't name 🟢 RESOLVED (2026-08-13)

### 4.1 File-type validation

**✅ RESOLVED (2026-05-13)** — merged into the §2.1 fix. Spec allows PDF / DOCX / plain text; the controller now rejects anything else with `415`, validated by extension **and** magic bytes (a renamed `.exe` cannot pass as `.pdf`).

### 4.2 Redis-down compensation

**✅ RESOLVED (2026-08-13).** Two layers:

- **Producer rollback** — every enqueue is now wrapped: if `queue.add()` throws, the already-committed rows and files are rolled back and the client gets a clear `503` (`createUploadCourse` removes file + document + course; `createTopicCourse` removes the course; `updateIntake` reverts the status to `intake_pending` while keeping goal+level, so the same request can be retried). No more zombie `ingesting` courses created at upload time.
- **Reconciliation** — `CourseService.reconcileStuckCourses()` finds courses stranded past 30 min (`ingesting` / `structuring`, plus `intake_pending` with goal+level set), skips any whose job is still live in its queue, and re-enqueues the rest with a fresh `<base>:rec-<ts>` jobId (the original id can linger in completed/failed state; workers are idempotent so re-runs are safe). Exposed as admin-only `POST /admin/courses/reconcile` (cron-wireable once Redis is up). Redis-down during reconciliation just skips the course until the next run.

### 4.3 Orphaned files on disk

**✅ RESOLVED (2026-08-13).**

- **Failure-path leak fixed** — the upload catch now removes the *renamed* file as well (previously it only unlinked the pre-rename temp path, so a failure after `rename` left the promoted file behind)
- **`DELETE /courses/:id`** — owner-only hard delete: interactive transaction wipes all course-scoped rows in dependency order (quiz attempts, module quizzes, completions, tutorials, QnA, practice problems, concept links, subtopics, modules, chunks, documents, exports, reports, marketplace queue, final project), then best-effort removes the uploaded file and the `assets/<courseId>/` figure dir. Learner-facing dependents (forks, purchases, classrooms, certificates) block deletion with `409` instead of cascading into other people's data; non-owner deletes get `404`
- **TTL sweep** — `cleanupFailedCourses()` (14-day default retention) hard-deletes courses stuck in `failed`, rows + files; exposed as `POST /admin/courses/cleanup-failed`

### 4.4 Concurrency & abuse

**✅ RESOLVED (2026-08-13) — rate limit, quota, duplicates; malware scan documented below.** All DB-backed, so they work while Redis is down and survive restarts:

- **Rate limit:** 10 uploads/user/hour (`course.count` on `createdAt` window) → `429`
- **Storage quota:** 500 MB/user (sum of `source_documents.fileSizeBytes` over owned courses) → `413`
- **Duplicate detection:** streaming SHA-256 of the uploaded bytes into new `source_documents.contentHash` column (migration `20260813130000_add_source_document_content_hash`, indexed) → re-uploading identical bytes under the same user gets `409` with the existing `courseId`
- **Malware scan:** deferred — no free local AV; the magic-byte/extension agreement check (§4.1) remains the only pre-parse screen. A hosted scanner or zip-bomb check belongs to a later hardening pass

### 4.5 Object-storage swap-in debt

**🟠 PARTIALLY RESOLVED (2026-08-13) — DB rows are now portable; the S3 backend itself awaits credentials.**

- New `src/common/utils/storage.ts` centralizes the contract: new uploads and figure paths are stored as **keys relative to `UPLOAD_DIR`** (forward-slash normalized); `resolveStoredPath()` resolves them back and passes legacy absolute paths through, so existing rows keep working
- Consumers (ingestion worker, asset saver, delete/cleanup) all go through this module — an S3/R2 swap replaces one file, not every call site (`@aws-sdk/client-s3` is already a dependency)
- Still open: the S3 provider implementation + path migration of pre-existing absolute rows (only needed once multi-instance deploys become real)

---

## 5. Missing — guardrail requirements (studystack-llm-handling.md) 🟠

**Partially resolved (2026-08-13):** the two hard ❌s (RLS, eval harness) are done/key-gated; the remaining rows are bounded by the missing Gateway key or deferred by design.

Spec'd guardrails; F1 is the entry point for all of them.

| Requirement | Section | Status |
|---|---|---|
| Uploaded content treated as data (delimited blocks, injection-hygiene system prompts) | §3.1 | 🟠 Phase B structuring prompt complies (delimited untrusted blocks + data-not-instructions rule); future prompts must follow the same pattern |
| `recursionLimit` + `costGuardNode` on the ingestion/structuring graph — a crafted document designed to loop the graph is an unbounded bill | §3.2a | ❌ no graph exists yet; nothing to bound (Phase B uses a single bounded call, not a graph) |
| **RLS on `source_chunks`** — policy + `app.current_course_id` scoping | §3.2b | ✅ **DONE 2026-08-13** — policy live on Neon; all five `source_chunks` call sites route through `common/utils/chunk-scope.ts` (`set_config(..., is_local=true)`); enforcement proven as non-owner role `_rls_probe` (deny-without-scope, zero foreign leak). Caveat: Neon connects as the table owner, which bypasses RLS even under FORCE — the policy is the enforced backstop from the moment a non-owner app role is introduced (`prisma/verify-rls.sql` re-checks on demand) |
| Per-feature Gateway API key (`generation` key for ingestion/structuring) | §7.1 | 🟠 client + env config done (`AI_GATEWAY_API_KEY`); key not yet provisioned in `.env` |
| Bounded exponential backoff for OCR/embedding provider flakiness, distinct from graph loop bounds | §5 | 🟠 Phase B: SDK `maxRetries: 2` + BullMQ exponential backoff on structuring; OCR remains local (Tesseract WASM) |
| Golden-set + red-team evals (injection-in-document cases are named red-team targets) | §4 | 🟠 **harness built 2026-08-13** — `scripts/evals-redteam.mjs`: offline tier (hostile-doc extraction, Zod caps, input budget, prompt hygiene) passes; live frontier tier (3 injection fixtures + golden-set through `generateCourseStructure`, marker-leak assertions) is key-gated on `AI_GATEWAY_API_KEY`; smoke suite carries an offline injection case |

---

## 6. Prioritized fix list

| # | Fix | Effort | Why this order |
|---|---|---|---|
| 1 | ~~File-type validation + failure contract~~ | ~~Small~~ | ✅ **DONE 2026-05-13** (§2.1 + §4.1) |
| 2 | ~~Enqueue-failure compensation (outbox or reconciliation job)~~ | ~~Small–medium~~ | ✅ **DONE 2026-08-13** (§4.2 producer rollback + admin reconciliation endpoint) |
| 3 | ~~Schema gaps before AiModule: `needs_research_fill` flag, `language` column~~ | ~~Small~~ | ✅ **DONE** — both already existed / were added; flagging + detection implemented in Phase A |
| 4 | ~~RLS uncomment + `app.current_course_id` wiring~~ | ~~Medium~~ | ✅ **DONE 2026-08-13** (§5 — policy applied + all call sites scoped + verified as non-owner role) |
| 5 | ~~The pipeline itself (parse → OCR → chunk → embed → backfill)~~ | ~~Large~~ | ✅ **Phases A/B/C code-complete (2026-08-13)** — parse → OCR → chunk → embed → structure → figures + backfill; only live frontier verification remains (Gateway key) |
| 6 | ~~Abuse controls (rate limit, quota), course deletion + file cleanup, object-storage migration~~ | ~~Medium~~ | ✅ **DONE 2026-08-13** (§4.3/§4.4 resolved; §4.5 rows portable, S3 backend awaits credentials); malware AV scan remains deferred |

---

## Appendix — quick reference

- **Endpoints today:** `POST /courses/upload`, `PATCH /courses/:id/attest-rights`, `GET /courses/:id/ingestion-status`, `DELETE /courses/:id` (owner-only hard delete), `POST /admin/courses/reconcile`, `POST /admin/courses/cleanup-failed` (admin-only maintenance)
- **Queues:** BullMQ `ingestion` (job `ingest-course`, priority 1, `jobId ingest:<courseId>`), `structuring` (job `structure-course`, priority 1, `jobId structure:<courseId>`, attempts 2, exponential 15 s backoff), `research` (job `backfill-subtopic`, priority 2, `jobId backfill:<subtopicId>`, attempts 2, exponential 30 s backoff; future F2 `research-course`)
- **Storage today:** local disk; DB rows store keys relative to `apps/api/uploads/` (`<courseId>-<sanitized-name>`; figures `assets/<courseId>/...`), resolved via `common/utils/storage.ts` (legacy absolute paths still read)
- **Abuse controls:** 10 uploads/user/hour (429), 500 MB/user quota (413), SHA-256 duplicate detection (409 + existing courseId)
- **Pipeline:** `IngestionProcessor` runs extract → figures → chunk → embed (recoverable) → converge; `StructuringProcessor` runs the bounded frontier call → `ready` → fires backfill producer; `BackfillProcessor` fills flagged subtopics into `tutorial_content`
- **Env:** `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` (pending), `AI_MODEL_FRONTIER`, `AI_MODEL_EMBEDDING` in `apps/api/.env.example`
- **Tests:** `apps/api/scripts/smoke-pipeline.mjs` (16 unit tests incl. red-team injection case), `scripts/e2e-ingestion.mjs` (Phase A DB E2E), `scripts/e2e-phaseb.mjs` (Phase B+C DB E2E, key-aware; no Redis needed), `scripts/e2e-phase-s4.mjs` (§4 DB E2E: rate limit, quota, duplicate, rollback, reconcile, TTL sweep, delete), `scripts/evals-redteam.mjs` (§5 guardrail evals, live tier key-gated), `prisma/verify-rls.sql` (+ `verify-rls-cleanup.sql`) — RLS policy probe on Neon
