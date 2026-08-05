# StudyStack — Project Structure & Package Selection

Turborepo monorepo, two apps (`web`, `api`), no separate Python service — matching the architecture decisions from the feature spec and tech stack discussion. Package versions below were checked against current releases as of early August 2026 rather than assumed from memory.

**Note on this revision (supersedes the previous one):** reflects two decisions made after the last pass:

1. **AI orchestration switched from the AI SDK's `ToolLoopAgent` to LangChain.js/LangGraph.js.** Vercel AI Gateway is retained, but only for what it's actually for — multi-LLM routing, per-feature spend visibility, and Zero Data Retention enforcement for minors — accessed through its OpenAI-compatible Chat Completions endpoint rather than the AI SDK's provider layer. This also brings the doc back in sync with the feature spec's original architecture-assumptions line, which had said LangChain.js/LangGraph.js all along.
2. **Corrected a factual error from the previous revision:** Prisma 7 does **not** natively support pgvector for a self-hosted Postgres instance. That's still `Unsupported("vector")` + raw SQL/TypedSQL, same as Prisma 6. Native ORM-level vector typing is on the roadmap for "Prisma Next" (a forthcoming major, not yet Prisma 7), and the early-access native support that does exist today is scoped to Prisma's own hosted **Prisma Postgres** product — not applicable here, since this project self-hosts Postgres 17.

Also folds in the three schema-level additions from the feature spec's resolution pass — a canonical `concepts` table, `provenance`/`license_status` fields for the copyright gate, and `age_bracket`/consent fields for Feature 19 — as before. None of these change the app boundaries below, but they affect the Prisma schema and `packages/types` build order.

---

## Monorepo layout

Package manager: **pnpm** (workspaces), build orchestration: **Turborepo**.

```
studystack/
├── apps/
│   ├── web/                      → Next.js (student + teacher UI)
│   │   ├── app/                  → App Router routes
│   │   ├── components/           → app-specific components (imports from packages/ui)
│   │   ├── lib/                  → client-side helpers (api-client wiring, hooks)
│   │   └── next.config.ts
│   │
│   └── api/                      → NestJS (business logic + all AI orchestration)
│       ├── src/
│       │   ├── course/            → CourseModule: upload/topic intake (F1–3), modules/subtopics/tutorial gen/caching (F4–6), concept resolution + admin dedup review (F4), public sharing + course_forks + copyright gate (F14), cross-course concept linking (F15)
│       │   ├── assessment/        → AssessmentModule: module quizzes + free-text grading (F7), final project (F9), step-by-step practice problems (F12) — grouped since all three are graded/reviewed student-response flows sharing quiz_attempts-adjacent data
│       │   ├── mastery/           → MasteryModule: scores, decay, spaced-repetition scheduler (F8), visual mastery map as a derived read view (F11); owns `concept_review_content` table (F8 shared cache for "different angle" regenerations — write path delegates the LLM call to `ai`, same pattern as `course` delegating tutorial generation to `ai`)
│       │   ├── classroom/         → ClassroomModule: teacher mode, aggregated views, consent/minors handling (F19)
│       │   ├── marketplace/       → MarketplaceModule: paid courses, payouts, SLA-bound admin review queue (F17)
│       │   ├── export/            → ExportModule: Anki (.apkg/CSV), PDF, Notion export (F13)
│       │   ├── certificate/       → CertificateModule: completion certificates + public verification URL, Stripe paid tier (F16)
│       │   ├── qna/               → Tutor & Q&A module (F10)
│       │   ├── ai/                → AiModule: LangChain/LangGraph orchestration, Gateway-backed model clients, image-source resolution, persona restyle layer (F18)
│       │   ├── auth/               → AuthModule: Passport/JWT, roles (student/teacher/creator/admin), user-level settings incl. explanation_style (F18)
│       │   ├── jobs/               → BullMQ processors (ingestion, course-level research, scheduler)
│       │   └── main.ts
│       ├── prisma/
│       │   └── schema.prisma      → single source of truth for the data model
│       └── nest-cli.json
│
├── packages/
│   ├── types/                    → shared Zod schemas + inferred TS types (Course, Module, Subtopic, TutorialContent, MasteryScore, Concept, etc.)
│   ├── api-client/                → typed fetch client generated from api's OpenAPI spec
│   ├── ui/                        → shared shadcn/ui-based React components
│   └── config/                    → shared eslint, tsconfig, tailwind config
│
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

**Why this shape:** `types` is the contract both `web` and `api` build against — define it before writing feature modules, since both sides need to agree on shapes (course, module, subtopic, tutorial_content, mastery_scores, concept) from day one. `api-client` is generated, not hand-written, so it can't drift from what `api` actually returns. Concept resolution (matching a generated subtopic against the canonical `concepts` table) reuses the same pgvector similarity infrastructure already in place for source-chunk retrieval — no second matching system needed.

### Feature → module traceability

The previous revision listed modules without checking them against all 19 features — three had no home at all (quiz, final project, practice problems), and two more were implicitly assumed to live somewhere but never stated (public sharing, cross-course linking). Fixed here; every feature now has exactly one owning module.

| Feature | Module | Note |
|---|---|---|
| 1. Upload Path | `course` + `jobs` | ingestion job async via BullMQ |
| 2. Topic-Only Path | `course` + `jobs` | research job async via BullMQ |
| 3. Intake: Goal + Level | `course` | |
| 4. Modules & Subtopics + concept resolution | `course` | admin dedup review screen (`concept_review_candidates`) lives here too, guarded to `admin` role |
| 5. Subtopic Tutorials | `course` (calls into `ai`) | generation logic itself is in `AiModule`; `course` owns the endpoint and cache-key logic |
| 6. On-Demand Generation & Caching | `course` | cross-cutting caching layer around Feature 5, not a separate module |
| 7. Module Quiz & Assessment | `assessment` | **was previously unowned** |
| 8. Adaptive Mastery Engine & Spaced Repetition | `mastery` | `concept_review_content` table owned here; generation call delegates to `ai` (same boundary as `course` → `ai` for tutorial generation) |
| 9. Final Project | `assessment` | **was previously unowned** |
| 10. In-Tutorial Q&A | `qna` | |
| 11. Visual Mastery Map | `mastery` | pure derived read view, no new storage |
| 12. Step-by-Step Practice Problems | `assessment` | **was previously unowned** |
| 13. Export to External Tools | `export` | |
| 14. Public Course Sharing | `course` | **was implicit, now stated** — `course_forks`, publish gate, moderation reports |
| 15. Cross-Course Knowledge Linking | `course` | **was implicit, now stated** — reads `concepts`/`mastery_scores` |
| 16. Verified Completion / Certificate | `certificate` | |
| 17. Course Marketplace | `marketplace` | admin review queue (`marketplace_review_queue`) lives here, guarded to `admin` role |
| 18. Explain-It-Your-Way Personas | `ai` (restyle logic) + `auth` (user setting) | **was previously unowned** — split across two modules since it's both a generation concern and an account setting |
| 19. Teacher / Classroom Mode | `classroom` | |

**On the `admin` role specifically:** rather than a catch-all `AdminModule`, admin-only endpoints (concept-dedup review, marketplace review queue, and — from the LLM-handling doc — golden-set/red-team eval-set maintenance) live inside the module that already owns the underlying data (`course`, `marketplace`), gated by a role guard, rather than centralized separately. Keeps the data access and the review action next to each other instead of splitting a feature's logic across two modules. The eval-set maintenance endpoints (LLM-handling doc §4) would sit in `ai` on the same principle, once built.

---

## apps/web (Next.js)

| Package | Notes |
|---|---|
| `next` | **v16.2.x** — current Active LTS major; v15 is now Maintenance LTS only |
| `react`, `react-dom` | **v19.x** — matched to Next 16's peer requirement |
| `tailwindcss` | latest v4 — new engine, faster builds |
| `shadcn/ui` components (via CLI, not an npm dependency) | accessible unstyled-by-default components |
| `@tanstack/react-query` | data fetching/caching; handles the ingestion/generation job-status polling pattern |
| `react-hook-form` + `zod` | forms + validation, sharing schemas from `packages/types` |
| `zustand` | lightweight client state (quiz-in-progress, tutorial nav) |
| `ai` + `@ai-sdk/react` | **Committed behaviour: stream on cache miss, return completed JSON on cache hit.** Feature 10's semantic cache returns a complete cached answer — streaming only applies to live LLM calls (cache-miss path). Client-side UI plumbing only; unrelated to the NestJS orchestration choice. The `qna` NestJS endpoint must therefore return either a stream or a JSON payload depending on the cache outcome, not always one or the other. |

---

## apps/api (NestJS)

| Package | Notes |
|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | **v11.x** — current stable major. NestJS 12 exists only as an alpha/`next`-tag prerelease (full ESM migration, Vitest/oxlint/Rspack swap) targeting ~Q3 2026 — too early to start a new project on |
| `@nestjs/config` | env/config management |
| `@nestjs/swagger` | generates the OpenAPI spec that `packages/api-client` codegens from |
| `@nestjs/passport`, `passport-jwt` | auth, roles for student/teacher/creator/admin |
| `class-validator`, `class-transformer` | DTO validation (NestJS's standard pairing) |
| `@nestjs/bullmq`, `bullmq`, `ioredis` | async job queue for the slow-path work (ingestion, course-level research) |
| `prisma`, `@prisma/client` | **v7.x** — current major. **Does not** natively type pgvector columns for self-hosted Postgres — see the Data model section below for the actual approach |
| `langchain`, `@langchain/core`, `@langchain/openai` | LangChain's core abstractions + the OpenAI-compatible chat-model client, pointed at Vercel AI Gateway's Chat Completions endpoint (see Orchestration note below) |
| `@langchain/langgraph` | stateful/branchy orchestration — research → outline → per-subtopic generation, resumable regeneration flows |
| `@langchain/langgraph-checkpoint-postgres` | persists LangGraph state to Postgres so a long-running job (ingestion research, multi-step generation) can resume after a crash or redeploy instead of restarting from scratch — a natural fit given BullMQ jobs already assume at-least-once delivery and the LLM-handling doc's idempotency requirements (§5) |
| `@langchain/community` (document loaders + text splitters) | **Committed** for Feature 1's ingestion pipeline — PDF/DOCX parsing and `RecursiveCharacterTextSplitter` for prose vs. math-OCR'd content. Using the ecosystem's native loaders rather than hand-rolling is the correct call given the fully LangChain-native stack; no hand-rolled alternative. |
| `multer`, `@aws-sdk/client-s3` (or R2's S3-compatible SDK) | file uploads to object storage |
| `stripe` | certificate paid tier + marketplace payouts |
| *(no WebSocket package — polling committed)* | Ingestion/generation job status is served via `GET /courses/{id}/ingestion-status` + React Query client-side polling, consistent with Feature 1 step 6 and Feature 6. `@nestjs/websockets` / `socket.io` removed — they were never required by the feature spec, and dropping them eliminates sticky-session complexity on Fly.io. Mastery decay scheduler (Feature 8's daily `next_review_at` recompute) uses a BullMQ repeatable job, not a separate cron package. |

### Orchestration note — LangChain/LangGraph via the Gateway, not the AI SDK

`AiModule` uses LangChain/LangGraph for all generation and agentic logic. Vercel AI Gateway stays in the stack, but purely as the multi-provider routing/billing/ZDR layer underneath it — accessed through its OpenAI-compatible endpoint:

```ts
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  modelName: "google/gemini-3-pro",       // provider/model string from the Gateway's catalog
  apiKey: process.env.AI_GATEWAY_API_KEY, // per-feature key, per LLM-handling doc §7.1
  configuration: { baseURL: "https://ai-gateway.vercel.sh/v1" },
});
```

Swapping models/providers per call site is a `modelName` string change, same as before — the "provider is a config value" property is preserved, just reached through LangChain's client instead of the AI SDK's. The per-feature Gateway API key pattern (`qna`, `generation`, `grading`, `research`) is a Gateway-level credential and works identically regardless of which client library calls it.

Structured output (Feature 5's combined `explanation`/`diagram_spec`/`image_source`/`example`/`resource_decision` call, Feature 4's module/concept JSON) uses `.withStructuredOutput(zodSchema)` on the chat model — the same Zod schemas already defined in `packages/types` plug in directly, no schema rework needed versus the AI SDK's `generateObject`.

The `ToolLoopAgent` max-iteration/max-cost caps required by the LLM-handling doc's §3.2 guardrail (bounding an injection-induced tool-call loop) have direct LangGraph equivalents — `recursionLimit`, a `costGuardNode`, and per-node/per-graph tracing with an exposed `traceId`. See **'Resolved from this revision'** below for the full translation table with canonical terms, per-graph scoping, and `traceId` exposure requirements. The LLM-handling doc's §3.2 and §7.2 must be updated to use this language; any remaining `ToolLoopAgent` references there are stale.

---

## packages/

| Package | Contents |
|---|---|
| `types` | Zod schemas for every core entity (Course, Module, Subtopic, TutorialContent, MasteryScore, QuizAttempt, Concept) — both apps import from here, never redefine independently |
| `api-client` | generated from `api`'s Swagger/OpenAPI output (e.g. via `openapi-typescript`), so `web` never hand-writes fetch calls against endpoints it can get typed for free |
| `ui` | shared shadcn/ui-based components (subtopic tutorial layout, quiz cards); **Visual Mastery Map graph component (Feature 11)** — non-trivial SVG/canvas work with live updates on every quiz submission and mastery decay recompute; owned by this package, consumed by `web`. Data is served by the `mastery` API as a derived read view; the rendering split (api owns data, `ui` owns component) is intentional and must stay that way — no mastery data access inside the component itself. |
| `config` | shared `eslint`, `tsconfig`, and `tailwind` config so both apps stay consistent |

---

## AI stack (models, vector storage, guardrails, observability)

This section didn't exist as its own table in the previous revision — pulling it together in one place since it now spans several separate decisions.

| Concern | Choice | Why |
|---|---|---|
| **Text/embedding provider** | Gemini for generation (as already decided); **Gemini Embedding** (001 / Embedding 2) as the default embedding model | Keeps provider surface small since generation is already on Gemini; Embedding 2 is natively multimodal (text/image/video/audio/PDF), which is genuinely useful given StudyStack ingests diagrams and math-OCR'd content alongside prose, not just plain text. Tops cross-lingual and long-document retrieval benchmarks as of mid-2026. |
| **Embedding alternative** | Voyage 4 / `voyage-context-4` | Worth switching to if retrieval quality on math/technical content becomes the bottleneck — currently benchmarks ahead of both OpenAI and Gemini on pure retrieval (NDCG@10), and the Voyage 4 family shares one embedding space across model sizes, so you can embed with the large model and query with a cheap one without re-indexing. |
| **Vector storage** | pgvector (HNSW index), inside the same Postgres 17 instance | Confirmed still the right call at this project's scale — matches or beats dedicated vector databases (Qdrant, Pinecone) at the 1M-vector range in current benchmarks, while keeping joins/transactions/row-level security for the course-scoped multi-tenant isolation the LLM-handling doc requires as a security boundary (§3.2), not just a convenience filter. |
| **Vector storage — schema approach** | `Unsupported("vector")` field + a hand-written `CREATE EXTENSION vector` migration + `$queryRaw`/TypedSQL for similarity queries | Required because Prisma 7 doesn't natively type pgvector for self-hosted Postgres (see the correction above). Functionally identical to the Prisma 6 workaround. |
| **Vector storage — future scaling path** | `pgvectorscale` (Timescale extension) | Not needed at launch; the natural next step if the project outgrows plain pgvector, extending HNSW performance/cost efficiency into the tens-of-millions-of-vectors range before a dedicated vector DB migration would be justified. |
| **Content moderation** | OpenAI's `omni-moderation` API (free, text + image) | Purpose-built for exactly the LLM-handling doc's §3.3 requirement — an independent moderation pass on generated text/images before writing to `tutorial_content`. Callable standalone; doesn't require routing generation through OpenAI. |
| **Cheap classifier calls** | Gemini Flash-Lite (or equivalent small model) | Fits the "smallest/cheapest available" tier in the LLM-handling doc's §2.1 model-tiering table — used for the mandatory off-topic classifier (§3.2, Feature 10) and doubles as a general-purpose LLM-judge safety filter, so one small model covers two guardrail jobs. |
| **Math-aware OCR** | **Google Document AI** (REST) | Committed — natural pick given Gemini/Google-Cloud adjacency; simpler credential surface since GCP auth is already needed for Gemini. Fall back to Mathpix only if Document AI's math formula accuracy proves insufficient on real-world test uploads before launch. |
| **Evals + observability** | **LangSmith** (dev through Feature 10 GA); migrate to **self-hosted Langfuse** on first of: (a) monthly LangSmith trace overage exceeds **$150/mo**, or (b) both Feature 5 and Feature 10 are in production and generating **>50k traces/month** sustained over any rolling 30-day window | LangSmith gives zero-config LangGraph tracing and LangGraph Studio visual debugging — the right tool while the graph topology is still being shaped and debugged. Langfuse (MIT, self-hostable) becomes the better fit once volume or cost makes LangSmith's per-seat/overage model a meaningful line item. **Hard constraint on eval-gate logic:** all golden-set/red-team blocking runs (LLM-handling doc §4) must use standard OpenTelemetry-compatible hooks, not LangSmith-specific SDK calls, so the migration is a config swap, not a rewrite. This constraint applies from the first eval run, not just when migration is imminent. |

---

## Infrastructure & external services

| Purpose | Choice |
|---|---|
| Database | PostgreSQL 17, with pgvector as a self-managed extension (see AI stack table above — not a native Prisma 7 feature) |
| Job queue | Redis, via BullMQ |
| Object storage | Cloudflare R2 or S3 — uploads, generated diagrams, images |
| Model routing | **Vercel AI Gateway** — accessed via its OpenAI-compatible Chat Completions endpoint from LangChain/LangGraph, so provider (Gemini, GPT, Claude, image models) is a config value, not hardcoded, without depending on the AI SDK |
| Stock photos | Unsplash or Pexels API — first choice for the `image_source: stock` path |
| Math-aware OCR | **Google Document AI** (REST) — committed; Mathpix noted as fallback only if formula accuracy falls short on real test uploads |
| Payments | Stripe |
| Error tracking | Sentry (has SDKs for both Next.js and NestJS) |
| Analytics | PostHog — useful specifically for tracking module drop-off, ties into the retention story |
| Evals / LLM observability | LangSmith → self-hosted Langfuse (see AI stack table for hard migration trigger thresholds) |

---

## Testing & CI/CD

- **Jest** — unit tests, native to both Next.js and NestJS
- **Playwright** — end-to-end flows (upload → course generation → quiz)
- **GitHub Actions** + **Turborepo remote caching** — CI only rebuilds what actually changed across the two apps and shared packages
- Golden-set and red-team eval runs (LLM-handling doc §4) plug into this same CI pipeline as a blocking gate on prompt/model changes, regardless of which eval platform ends up hosting the runs

---

## Deployment

- `web` → Vercel (native Next.js fit)
- `api` → **Fly.io** — committed over Railway. Rationale: Postgres 17 and Redis are both self-managed externally (not Railway addons), BullMQ requires persistent long-running processes, and polling-based job status means no sticky-session requirements. Fly.io's per-machine pricing and persistent volume support are a better fit at this workload profile. The LangChain "can't run at the edge" tradeoff that some comparisons raise never applied here — `api` was never going to be an edge function.

---

## Build order recommendation

1. `packages/types` — the shared contract, first, including `Concept` and the `provenance`/`license_status`/`age_bracket` enums from day one — retrofitting these after Features 4–8 are built means a data migration and backfill across existing `quiz_attempts`/`mastery_scores` rows
2. `apps/api`'s Prisma schema + core modules (Course, Mastery, Auth) — `concepts`/`subtopic_concepts` belong in this initial schema, not bolted on when Feature 15 is built; this is also where the pgvector extension + `Unsupported("vector")` migration gets written. **Also stub (tables + columns, no endpoints yet) `quiz_attempts` and `mastery_scores` in this initial schema** — both need the `concept_id` FK and `age_bracket`-gated columns from day one; adding these retroactively after real data exists is a migration + backfill. `AssessmentModule` schema (tables, DTOs) can be scaffolded at this step too — **but Assessment's quiz-generation endpoint must not be wired until step 5**, since it depends on `AiModule`'s `resolveConceptsForSubtopic()` having populated `subtopic_concepts` first.
3. `packages/api-client` generation off the running API
4. `apps/web` — build against the typed client from day one, not raw fetch calls
5. `AiModule` (LangChain/LangGraph wiring + generation pipeline, Gateway-backed model clients) — once the data model and course structure endpoints are stable, since generation writes into `tutorial_content` and needs those tables to already exist; the concept-resolution step (Feature 4) is part of this module and depends on `concepts` already existing. **Wire Assessment's quiz-generation endpoint only after this step** — quiz generation selects from `subtopic_concepts` rows that `AiModule` populates, so the endpoint is not functionally testable until concept resolution has run at least once.

---

## Resolved from this revision

**[RESOLVED] LLM-handling doc §3.2 and §7.2 — `ToolLoopAgent` → LangGraph translation**

The LLM-handling doc's `ToolLoopAgent` guardrail language maps to LangGraph as follows — these are now the canonical terms; any remaining `ToolLoopAgent` references in that doc are stale and must be updated to match:

| ToolLoopAgent concept | LangGraph equivalent | Where it lives |
|---|---|---|
| Max-iteration cap | `recursionLimit` on the compiled graph (`graph.compile({ recursionLimit: N })`) | Set per-graph in `AiModule` — Feature 5's generation graph and Feature 10's Q&A graph each get their own limit, not a shared global |
| Max-cost cap | A dedicated `costGuardNode` that runs **before every LLM-call node** in the graph; accumulates token-count estimates from prior node outputs; throws a `CostLimitExceededError` (caught at the graph runner level) and returns whatever partial output has been assembled so far, rather than abandoning the run entirely | Lives in `AiModule`; `CostLimitExceededError` must be a named, exported error class so callers can distinguish a cost-abort from a real failure and handle each appropriately |
| Per-call tracing | Per-node tracing — each LangGraph node is a discrete, named trace span natively in both LangSmith and Langfuse (via OpenTelemetry); no additional instrumentation needed beyond naming nodes descriptively | Node names in every graph must be descriptive strings (e.g. `"retrieveChunks"`, `"generateExplanation"`, `"costGuard"`), not anonymous functions, so spans are readable in the trace UI |
| Per-graph tracing | LangGraph's graph-level run ID (auto-assigned per `invoke()` call) groups all node spans under a single root trace | Exposed on every `AiModule` method response as a `traceId` field so downstream callers (e.g. `CourseModule`) can log it against the relevant `tutorial_content` or `qna_messages` row for post-hoc debugging |

The §3.2 framing ("Feature 5's generation isn't one call, it's the `ToolLoopAgent` running...") should be rewritten as: *"Feature 5's generation is a LangGraph graph run, bounded by `recursionLimit` and a `costGuardNode`, with per-node trace spans grouped under a single root trace ID."*

---

**[RESOLVED] Evals platform — hard decision with migration trigger**

See the updated AI stack table row above. The decision is now: **LangSmith** from first commit through Feature 10 GA; migrate to **self-hosted Langfuse** on whichever comes first — monthly LangSmith trace overage exceeding **$150/mo**, or both Feature 5 and Feature 10 generating **>50k traces/month** sustained. The eval-gate logic constraint (OpenTelemetry-compatible hooks only, no LangSmith-specific SDK calls) is a build-time rule, not a migration-time one — it applies from the first golden-set eval run.
