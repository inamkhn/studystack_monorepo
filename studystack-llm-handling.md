# StudyStack — LLM Handling: Guardrails, Evals, Reliability, Observability

Written from scratch against the current state of the other four docs (features spec, project structure, Prisma schema, vector-schema SQL) plus everything already resolved about the AI stack — not a first draft in isolation. Section numbers below (§2.1, §3.2, §3.3, §4, §7.1, §7.2) match what the project-structure doc already cross-references, so this doc slots in without renumbering anything downstream. Written directly in LangChain.js/LangGraph.js terms throughout — the project-structure doc's translation table exists specifically because an earlier version of this doc used the AI SDK's `ToolLoopAgent` language; this version doesn't reintroduce that staleness.

---

## 1. Overview

StudyStack calls an LLM in eight distinct places: module/subtopic structuring (F4), concept resolution (F4), tutorial generation (F5/F6), quiz/final-project generation and grading (F7/F9), mastery review-content generation (F8), Q&A (F10), practice-problem generation (F12), and course-research for the topic-only path (F2). Every one of these shares three properties that shape this doc:

- **Untrusted input reaches the model in most of them.** Uploaded documents (F1), student free-text (F10, quiz answers), and web research results (F2) are all attacker-reachable surfaces, not just the student's own prompt box.
- **Output is written to shared, cross-student storage in several of them** (`tutorial_content`, `concept_review_content`, `qna_messages` cache) — a bad generation doesn't just affect the student who triggered it, it can propagate to every student who hits that cache afterward.
- **A meaningful fraction of users are minors** (self-serve accounts with unresolved `age_bracket`, plus classroom accounts explicitly tagged `minor_school_consented`) — this isn't an edge case to bolt on later, it's a standing constraint on every guardrail below.

---

## 2. Model Selection & Tiering

### 2.1 Model-tiering table

| Tier | Model | Used for |
|---|---|---|
| **Frontier generation** | Gemini (current flagship, routed via Gateway as a config value — see §7.1) | Tutorial generation (F5/F6), module/subtopic structuring (F4), quiz question generation (F7), final-project prompt generation (F9), concept-review content (F8), practice problems (F12) |
| **Frontier generation — alternate provider** | Claude or GPT (Gateway model-string swap only, no code change) | Fallback when the primary provider has a sustained outage (see §5) or when a specific call site benefits from a different provider's strengths — provider is a config value at every call site by design, not hardcoded |
| **Structured extraction / grading** | Gemini, same tier as generation, via `.withStructuredOutput(zodSchema)` | Free-text quiz/final-project grading (F7/F9) — rubric-graded against a Zod schema shared from `packages/types`, not free-form text parsing |
| **Embeddings** | Gemini Embedding (001 / Embedding 2), natively multimodal | `source_chunks.embedding`, `concepts.embedding`, and (per the schema gap closed in the endpoints review) `qna_messages.embedding` |
| **Embeddings — alternate** | Voyage 4 / `voyage-context-4` | Swap-in if retrieval quality on math/technical content becomes the bottleneck (per project-structure doc) |
| **Smallest/cheapest tier** | Gemini Flash-Lite (or equivalent) | Feature 10's mandatory off-topic classifier (§3.2), and doubles as a general-purpose LLM-judge safety filter — one small model, two guardrail jobs, per the project-structure doc's explicit reasoning |
| **Moderation (not a chat model)** | OpenAI `omni-moderation` (free, text + image) | Independent moderation pass on generated content before it's written to shared storage (§3.3) — callable standalone, doesn't require routing generation itself through OpenAI |

**Rule for adding a new call site:** pick the cheapest tier that can do the job correctly, not the frontier tier by default. Classification/routing/off-topic-detection tasks belong in the cheapest tier unless a specific eval (§4) shows it isn't accurate enough there.

---

## 3. Guardrails

### 3.1 Untrusted-input handling (general layer)

Every call site that includes uploaded-document content, web-research results, or student free-text in a prompt treats that content as data, not instructions — standard prompt-injection hygiene (delimited/tagged input blocks, system instructions that explicitly state retrieved content may contain attempted instructions and those must be ignored). This applies uniformly across F1 (upload ingestion), F2 (topic research), F5/F6 (tutorial generation grounded in source chunks), and F10 (Q&A grounded in source chunks + tutorial content).

### 3.2 Bounding an injection-induced tool-call loop, course-scoped isolation, and the minors topic-scope classifier

Three distinct guardrails live in this section because they're the three ways a single bad input (malicious upload content, or an off-topic/manipulative question) can cause runaway cost, cross-tenant data exposure, or age-inappropriate output:

**a. Max-iteration / max-cost bounding.** Every LangGraph graph that can loop (retrieval → generate → self-critique → retry patterns, most relevantly F5's generation graph and F10's Q&A graph) is compiled with an explicit `recursionLimit` — set per-graph in `AiModule`, not a shared global, since F5 and F10 have different legitimate iteration depths. A dedicated `costGuardNode` runs before every LLM-call node in the graph, accumulating token-count estimates from prior node outputs, and throws a named `CostLimitExceededError` when the graph's cost ceiling is reached — caught at the graph-runner level, returning whatever partial output has been assembled rather than abandoning the run entirely. This is what stops a crafted upload (e.g. a document containing text designed to make the structuring/generation graph loop indefinitely) from becoming an unbounded bill.

**b. Course-scoped isolation as a security boundary, not just a convenience filter.** Every retrieval query against `source_chunks` and `concepts` (F5's tutorial generation, F10's Q&A, F4's concept resolution) must be scoped to the requesting student's accessible course(s) — enforced as a hard boundary, not an application-level "we usually remember to add `WHERE courseId = ?`" convention. `studystack-vector-schema.sql` already contains the intended enforcement mechanism — Postgres row-level security on `source_chunks`, keyed off a `SET LOCAL app.current_course_id` session variable — but it's currently commented out, explicitly pending `AiModule` wiring that session variable per request. **That wiring is a §3.2 requirement, not an optional hardening pass** — until `AiModule` sets `app.current_course_id` on every request and the RLS policy is uncommented, course isolation is only as strong as every call site remembering its own `WHERE` clause, which is precisely the failure mode RLS exists to eliminate. This should land no later than step 5 of the project-structure doc's build order (when `AiModule` itself is built), not deferred to a later hardening pass.

**c. Minors topic-scope classifier (Feature 10).** Any account with `age_bracket != adult` gets a mandatory pre-generation classifier pass (Flash-Lite tier, §2.1) on every Q&A question before it reaches the main generation call: confirm the question is genuinely on-topic for the subtopic/course, not an attempt to redirect the model into unrelated or unsafe territory. On a miss, refuse and redirect back to the course material rather than answering — this is a hard behavioral difference for minor accounts, not a configurable teacher setting (per Feature 19's compliance section), and it sits in the Q&A graph itself as a node (`"scopeClassifier"` or similar, per the tracing naming convention in §7.2), not as an external pre-check that could be bypassed by calling the graph directly.

### 3.3 Output moderation pass

Every piece of AI-generated content that will be written to shared, cross-student storage — `tutorial_content` (F5/F6), `concept_review_content` (F8) — passes through OpenAI's `omni-moderation` API (text + image) as an independent pass *after* generation and *before* the write. This is deliberately separate from whatever safety instructions are in the generation prompt itself: a moderation classifier catches what a generation-time system prompt missed, and because the output is cache-shared across every student who hits that `tutorial_content`/`concept_review_content` row afterward, a miss here has much higher blast radius than a single bad Q&A answer (which is scoped to one exchange, not silently reused). A moderation failure blocks the write and falls back to a retry with an adjusted prompt (see §5), not a silent pass-through.

**Content provenance (F14's copyright/`license_status` gate) is a separate concern from content safety and is not part of this section** — provenance gates whether reused-upload content can be published/sold, moderation gates whether generated content is safe to show at all. Don't conflate the two when implementing; they run at different points in different flows (provenance at publish-time in `CourseModule`, moderation at generation-time in `AiModule`).

---

## 4. Evals

Two eval categories, both blocking gates in CI (GitHub Actions + Turborepo, per the project-structure doc), not advisory:

- **Golden-set regression evals.** A fixed set of known-good input/output pairs per generation call site (structuring, tutorial generation, concept resolution, quiz generation/grading, Q&A) that must continue passing quality/accuracy thresholds on every prompt or model change. Concept-resolution's three-way confidence threshold (confident/ambiguous/no-match, F4) is a natural golden-set target — a threshold drift there silently degrades the whole concept graph that F8/F11/F15 depend on.
- **Red-team evals.** Adversarial inputs targeting the §3 guardrails specifically — injection attempts in uploaded documents, off-topic-classifier bypass attempts phrased to look legitimate, moderation-bypass phrasing. These are the tests that would have caught a regression in §3.2's classifier or §3.3's moderation pass before it reached production.

**Hard constraint, from the first eval run onward:** all eval-gate logic uses standard OpenTelemetry-compatible hooks, not LangSmith-specific SDK calls — this is a build-time rule, not something retrofitted at migration time. The evals platform is **LangSmith** from first commit through Feature 10 GA, with a committed migration trigger to self-hosted **Langfuse** (MIT) on whichever comes first: monthly LangSmith trace overage exceeding **$150/mo**, or Feature 5 + Feature 10 combined sustaining **>50k traces/month** over any rolling 30-day window. Building eval-gate logic against OTel hooks from day one is precisely what makes that migration a config swap rather than a rewrite.

---

## 5. Reliability & Cost Controls

- **Structured output validation is itself a reliability guardrail, not just a convenience.** Every generation call that produces structured data (F4's module/concept JSON, F5's combined `explanation`/`diagram_spec`/`image_source`/`example`/`resource_decision` object) uses `.withStructuredOutput(zodSchema)` against the same Zod schemas defined once in `packages/types` — malformed output is a schema-validation failure caught before it's written anywhere, not a runtime error surfacing downstream in `web`.
- **Provider fallback.** Since every call site reaches the model through the Gateway's OpenAI-compatible endpoint with the provider as a config string (§2.1), a sustained outage on the primary provider (Gemini) is handled by a fallback model string (Claude or GPT), not a hard failure — this needs a defined threshold (consecutive failures / error-rate window) and a defined fallback model per call site, not a single global fallback, since grading and generation have different acceptable-quality bars for a fallback provider.
- **Cost-abort partial output, not full failure.** Per §3.2's `costGuardNode`, a cost-ceiling hit returns whatever partial output has been assembled — e.g. a partially-generated module structure — rather than discarding the whole run. Callers (`CourseModule`, `AssessmentModule`) must distinguish a `CostLimitExceededError` from a genuine failure and handle each differently: a cost-abort with usable partial output can be surfaced to the student as "still generating" with the partial result cached, while a genuine failure needs a real retry.
- **Retry policy on transient failures** (rate limits, timeouts, 5xx from the provider) is a bounded exponential backoff at the Gateway-client level, distinct from `recursionLimit`/`costGuardNode` — those bound *the graph's own looping behavior*, this bounds *infrastructure flakiness*. Conflating the two risks either retrying past the cost ceiling or treating a rate-limit blip as a graph-logic failure.

---

## 6. Minors & Compliance

- **Zero Data Retention (ZDR) enforcement for minors** is a Gateway-level setting per the project-structure doc's stated rationale for keeping the Gateway in the stack at all (multi-LLM routing, per-feature spend visibility, and ZDR enforcement for minors) — any request from an account with `age_bracket != adult` must be routed with ZDR enabled at the Gateway, not left to provider-default retention settings.
- **`age_bracket` gates behavior at generation call sites too, not just at the endpoint layer.** §3.2(c)'s topic-scope classifier is the clearest example, but any future generation call site that touches student-authored free text (e.g. a hypothetical open-ended reflection feature) needs the same age-gated review before it's added — this doc's guardrails are call-site-scoped by design so new features inherit the pattern rather than needing a bespoke minors review each time.
- **Analytics exclusion.** Per Feature 19's resolved compliance section, any account with `age_bracket != adult` is excluded from PostHog analytics streams outright — this is an application-layer filter on what gets sent to PostHog, not an LLM-handling concern per se, but it's listed here because it's part of the same "minors get systematically different treatment, not opt-in restriction" principle as the two points above.

---

## 7. Observability

### 7.1 Per-feature Gateway API keys

The Vercel AI Gateway is used with per-feature API keys — `qna`, `generation`, `grading`, `research` — rather than one shared key across every call site. This is what makes per-feature spend visibility (one of the two stated reasons for keeping the Gateway at all) actually work: a cost spike shows up against a specific feature's key, not as an undifferentiated total. Every new call site added to `AiModule` picks up an existing feature key or gets a new one — it should never default to reusing an unrelated feature's key just because it's convenient at the call site.

### 7.2 Tracing

Every LangGraph node is a discrete, named trace span natively (via OpenTelemetry, works identically under LangSmith or Langfuse — see §4's migration constraint) — no additional instrumentation needed beyond naming nodes descriptively (`"retrieveChunks"`, `"generateExplanation"`, `"scopeClassifier"`, `"costGuard"`, not anonymous functions), so spans stay readable in the trace UI regardless of which platform is hosting them. LangGraph's graph-level run ID (auto-assigned per `invoke()` call) groups all node spans under a single root trace. Every `AiModule` method exposes this as a `traceId` field on its response, so downstream callers (`CourseModule`, `AssessmentModule`, `QnAModule`) can log it against the relevant `tutorial_content`, `qna_messages`, or `quiz_attempts` row — this is what makes a bad generation result debuggable after the fact instead of only during the live request.
