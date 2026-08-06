# StudyStack — Feature Specifications (Resolved)

Every confirmed feature, written with enough implementation detail to hand to a coding agent (e.g. Cursor) or build from directly. Each feature covers: what it does, how it behaves step-by-step, the data involved, and edge cases/rules to enforce.

Core data model referenced throughout: `users`, `courses`, `modules`, `subtopics`, `tutorial_content`, `quiz_attempts`, `mastery_scores`, `source_documents`, `source_chunks`, `concepts`, `subtopic_concepts`.

**Note on this revision:** this version folds in three fixes identified during a pre-build review: (1) `concepts` is now a real table with resolved IDs, established at generation time, rather than a free-text tag introduced piecemeal in Feature 7 — everything downstream (mastery, cross-course linking) depends on this being consistent from the start; (2) a copyright/provenance gate on publishing (Features 14, 17) so content reused from a student's uploaded source material can't be redistributed without attestation; (3) explicit minors/classroom-compliance handling for Feature 19, since it's the primary paid B2B surface and almost certainly touches under-18 accounts.

**Note on this resolution pass:** this version closes out every bottleneck/tradeoff identified in the pre-build review — concept-resolution fragility, cache-vs-personalization tension, uncapped per-student cost surfaces, publish-time scan cost, human-review bottlenecks, and every previously-deferred design fork. Each fix is called out inline as **[RESOLVED]** at the relevant feature, with the new data model or rule stated explicitly rather than left as a recommendation. Nothing here waits on the LLM-handling doc — those cost/guardrail mechanics are covered separately; this pass only resolves what's addressable within feature scope.

**Architecture assumptions used throughout this doc:** two apps — `web` (Next.js) and `api` (NestJS) — with all AI orchestration (research, generation, Q&A) living inside NestJS via LangChain.js/LangGraph.js. No separate Python service. All LLM and image-generation calls route through Vercel AI Gateway, so the underlying model/provider (Gemini, GPT, Claude, image models) is a config value per call site, not hardcoded — this is what makes provider flexibility and cheap/strong model mixing possible without rewriting call sites. Document ingestion's math-aware extraction calls a hosted OCR API (e.g. Mathpix or Google Document AI) over REST rather than running a self-hosted model.

---

## Part 1: Core Learning Engine

### 1. Upload Path

**What it does:** Student uploads a syllabus, textbook, or notes; the system extracts and structures it into a course.

**How it works:**
1. User uploads a file (PDF, DOCX, or plain text) on the course-creation screen.
2. File is stored in object storage; a `courses` row is created with `source_type = upload`, `status = ingesting`.
3. An async ingestion job runs:
   - Splits content by type per page/section: plain text, math/structured notation, images/diagrams.
   - Extracts text via a standard parser; math-heavy pages route through a hosted math-aware OCR API (e.g. Mathpix or Google Document AI) via REST call if equations are stored as images — no self-hosted OCR model or separate service needed.
   - Extracts and keeps images/diagrams linked to their source section (not floating loose).
   - Flags any section that resolves to just a heading with no real body ("Week 3: Elasticity", nothing else) as `needs_research_fill`.
4. Extracted text/images are chunked and embedded into the vector store, scoped to that course's `source_documents`.
5. Any `needs_research_fill` sections are queued through the same generation path as Feature 2 (Topic-Only Path) to backfill content — **[RESOLVED — queue priority]** these backfill jobs are enqueued at **lower priority** than a first-time ingestion job for a brand-new course. Priority tiering: `new_course_ingestion` (highest) > `needs_research_fill_backfill` > `regeneration/other`. This prevents a burst of large uploads from starving small, quick-to-finish courses behind a backlog of backfill work. Priority is a job-queue attribute (BullMQ priority field), not a separate queue.
6. Client polls `GET /courses/{id}/ingestion-status` until `status = ready`, then loads the generated module list (Feature 4).

**Data model:**
- `source_documents`: `id, course_id, file_url, file_type, extraction_status, license_status`
- `source_chunks`: `id, document_id, chunk_text, page_ref, section_ref, embedding_id`

`license_status` (enum: `user_uploaded_unknown | open_license | public_domain`) defaults to `user_uploaded_unknown` for every file a student uploads — this drives the publish gate in Feature 14/17. Don't default it to anything more permissive; the student uploading a file is not a rights claim.

**[RESOLVED — early attestation, reduces publish-time funnel drop-off]** The safe `user_uploaded_unknown` default is unchanged, but the rights-attestation step no longer has to be encountered for the first time at course completion. At upload time, present a single optional, skippable checkbox: *"I confirm I have rights to redistribute this material if I choose to publish this course later."* If checked, immediately set `courses.publish_attestation_at` (same field Feature 14 checks at publish time) rather than waiting until publish. This doesn't change the default or the gate — it just lets students who already know they'll publish clear the block early instead of hitting a wall at the end.

**Edge cases:**
- Corrupted/unreadable file → surface a clear error; don't create an empty course silently.
- Large uploads (400+ pages) → process in chunks, don't block the UI; return incremental progress via the status endpoint.
- Non-English source → detect language, keep generated tutorial content in the source's language by default.

---

### 2. Topic-Only Path

**What it does:** Student types a subject with no upload; the system researches it and builds the course from scratch.

**How it works:**
1. User submits a topic string (e.g. "Microeconomics").
2. `courses` row created with `source_type = topic`.
3. Research & RAG service queries trusted external sources (open textbooks, verified reference material), retrieves and chunks relevant content, embeds it into the vector store scoped to this course — same storage shape as an uploaded document, just sourced externally instead of from a file.
4. Proceeds identically to the upload path from module generation (Feature 4) onward — this is the point where both paths converge.

**Data model:** Same `source_chunks` table as Feature 1; `source_documents.file_url` is null for topic-sourced chunks, with a `source_url` field instead pointing at the external reference. `source_documents.license_status` for these rows should be set to `open_license` (research is scoped to open textbooks/verified reference material by design) rather than the `user_uploaded_unknown` default used for Feature 1 — this is what lets topic-only courses publish without the attestation step required for upload-sourced ones (see Feature 14).

**Edge cases:**
- Topic too vague ("Science") → prompt should force the research step to pick a reasonable default scope, or the intake step (Feature 3) should catch this by asking for a narrower subject.
- No reliable sources found for a niche topic → fall back to model-generated content but flag the course as `grounding: low-confidence` so this can be surfaced in UI if needed later.

---

### 3. Intake: Goal + Level

**What it does:** Two-question check before generation: why the student is learning this, and their current level.

**How it works:**
1. Immediately after topic/upload submission, before any generation starts, present two single-select questions:
   - Goal: class / exam prep / curiosity
   - Level: beginner / some background
2. Store both as fields on the `courses` row: `goal`, `level`.
3. Both values are injected into every downstream generation prompt (module generation, tutorial generation) so depth and framing match — e.g. `level = beginner` triggers simpler language and more foundational modules; `goal = exam prep` biases toward denser review scheduling later (Feature 8).

**Data model:** `courses.goal`, `courses.level` (enums).

**Edge cases:**
- User skips/doesn't answer → default to `goal = curiosity, level = beginner` rather than blocking course creation.

**[RESOLVED — mid-course level change]** Changing `level` mid-course is now in scope for v1, scoped narrowly to avoid forcing a second generation pipeline:
- Changing `level` re-triggers generation **only** for subtopics not yet completed by the student (future/incomplete content) — completed subtopics keep their original-level `tutorial_content` untouched, since Feature 6's cache means most content is shared cohort-wide anyway and regenerating it retroactively would fragment the cache for other students at the old level.
- Changing `level` does **not** re-trigger module structure regeneration or re-ordering — the module/subtopic outline (Feature 4) and its `concept_id` mappings stay fixed. Only the generation *depth* of remaining tutorials changes.
- Changing `goal` mid-course (e.g. curiosity → exam prep) only affects Feature 8's review-interval scheduling going forward; it never touches existing `tutorial_content`.
- Data model addition: `courses.level_changed_at` (nullable timestamp) — lets the client distinguish "content generated under the current level" from "content generated under a prior level" for any future UI need (e.g. a subtle badge), without needing to diff prompts after the fact.

---

### 4. Modules & Subtopics (Course Structure)

**What it does:** Breaks the topic into a dependency-ordered sequence of modules, each broken into subtopics.

**How it works:**
1. Once source chunks exist (from either path), call the LLM with the full set of retrieved chunks + goal/level to produce a structured outline: an ordered list of modules, each with an ordered list of subtopics. Request structured JSON output (module title, order index, subtopic titles, order index, and a list of candidate concept names per subtopic) — no prose wrapper.
2. For uploads with a clear existing chapter structure, prefer that ordering as the backbone rather than re-deriving it — pass the source's own headings into the prompt as a strong prior.
3. Persist as `modules` rows (`course_id, order, title`) and `subtopics` rows (`module_id, order, title`).
4. **Concept resolution (establishes the canonical identity used by Features 7, 8, and 15):** for each subtopic's candidate concept names, resolve against the existing `concepts` table via embedding similarity — reuse the same pgvector infrastructure already used for source-chunk retrieval, don't stand up a second matching system. Persist the result as `subtopic_concepts` rows. This has to happen here, at structure-generation time, not deferred to quiz generation (Feature 7) — quiz questions need a stable `concept_id` to tag against, not a string they invent independently.

   **[RESOLVED — three-tier match outcome, replaces binary match/no-match]** Instead of a single similarity threshold deciding match vs. no-match, resolution now produces one of three outcomes per candidate concept name:
   - **`confident_match`** (similarity above the high-confidence threshold) → auto-reuse the existing `concept_id`. No review needed.
   - **`ambiguous`** (similarity in the borderline band) → **auto-create a new `concepts` row** (so nothing blocks course generation), but tag it `match_status = pending_review` and link it to the nearest existing candidate via a new `concept_review_candidates(id, new_concept_id, candidate_concept_id, similarity_score, status, reviewed_by, reviewed_at)` table. The course ships immediately with a working (if possibly-duplicate) concept; review is decoupled from the critical path.

   **Note — this deliberately reverses the original edge-case rule, not just fixes it:** the original doc said "don't silently create a duplicate on a borderline score." This resolution does the opposite on purpose — it auto-creates and flags rather than blocking. The tradeoff being made explicit: blocking generation on every ambiguous match would stall the pipeline on a judgment call that may not matter to this particular student's course; auto-creating with a visible, actionable flag accepts a small, bounded, *fixable* amount of duplicate-concept debt (cleaned up via merge, below) in exchange for never blocking a student's course on a human reviewer. Worth confirming this tradeoff is the right one for the product, since it's a real behavior change from the original spec, not a mechanical fix.
   - **`no_match`** (below the borderline band) → auto-create a clean new `concepts` row, no review flag.

   This replaces the old "log for periodic admin/dedup review" note with an actual actionable queue: `concept_review_candidates` rows with `status = pending_review` are exactly what an admin dedup screen queries against, and each row already has the two concept IDs needed to act on it.

   **[RESOLVED — merge as a first-class operation]** When an admin confirms two concepts are duplicates, a `mergeConcepts(surviving_id, duplicate_id)` operation runs as a single transaction:
   - Reassign every `subtopic_concepts.concept_id`, `quiz_attempts.concept_id`, and `mastery_scores.concept_id` row referencing `duplicate_id` to `surviving_id`.
   - If a student already has `mastery_scores` rows for *both* `duplicate_id` and `surviving_id` (possible if they hit both before the merge), combine them by taking the higher score and the more recent `last_reviewed_at` rather than summing or averaging — mastery isn't additive.
   - Mark the duplicate `concepts` row `merged_into = surviving_id` (soft-delete, not hard-delete) so historical `ai_call_logs`/audit references don't dangle.
   - Update the originating `concept_review_candidates` row to `status = resolved_merged`.

   **[RESOLVED — structural guarantee against orphaning mastery history]** The earlier rule ("Feature 8's regeneration must not re-run concept resolution") is now enforced by module boundary, not by comment/discipline: `subtopic_concepts` rows are writable **only** from a single service method, `resolveConceptsForSubtopic()`, called exactly once per subtopic at structure-generation time (this step). Feature 8's "different angle" regeneration calls a separate method, `regenerateTutorialContent()`, which has no code path with write access to `subtopic_concepts` — enforced at the module/service layer (separate repository injection), so a future engineer physically cannot wire regeneration into concept re-resolution without deliberately changing the module's write permissions, not just forgetting a rule.

5. Return the structure to the client; this is what renders as the sidebar/course map.

**Data model:**
- `modules(id, course_id, order, title)`, `subtopics(id, module_id, order, title)`
- `concepts(id, canonical_name, subject_area, aliases text[], created_at, match_status, merged_into)` — canonical, shared across all courses and students, not scoped to one course. `match_status` (enum: `confident | pending_review | resolved`), `merged_into` (nullable self-referencing FK, set on soft-delete-via-merge).
- `subtopic_concepts(subtopic_id, concept_id)` — many-to-many; a subtopic can map to more than one concept (e.g. a subtopic on "Elasticity" might tag both `price-elasticity` and `supply-demand`)
- `concept_review_candidates(id, new_concept_id, candidate_concept_id, similarity_score, status, reviewed_by, reviewed_at)` — the actionable dedup queue described above.

**Edge cases:**
- LLM returns malformed JSON → validate against a schema, retry once, then fail the job with a visible error rather than persisting a broken structure.
- Circular or ambiguous dependency in source material → resolve by defaulting to the source's literal order; don't attempt automatic dependency-graph re-sequencing in v1 (too failure-prone to trust silently).
- A subtopic's concept mapping must stay stable across regenerations — enforced structurally now (see above), not just documented as a rule.

---

### 5. Subtopic Tutorials

**What it does:** Each subtopic's actual lesson content: explanation, diagram, image, example, and optional external resources.

**How it works (generation, see also Feature 6 for timing):**
1. Retrieve top-k relevant chunks for this subtopic from the vector store (course-scoped).
2. Single LLM call (or a LangGraph.js multi-step chain, run inside the NestJS `api` app, model routed through Vercel AI Gateway so the provider is a config value) produces, as structured output:
   - `explanation`: plain-language text grounded in retrieved chunks
   - `diagram_spec`: either `{reuse: source_image_id}` if a qualifying original diagram exists (see rule below) or `{generate: <structured diagram description>}` to be rendered as SVG
   - `image_source`: `{type: stock, query: <search query>}` for a real-world grounding photo, `{type: generated, prompt: <image prompt>}` for an illustrative image with no real-world equivalent, or `{type: none}` (see rule below) — separate from `diagram_spec`: the diagram explains mechanics, the image grounds the concept in reality
   - `example`: a concrete real-world or relatable example
   - `resource_decision`: `{needed: bool, type: video|article|tool, query: <search query>}` — the model decides whether an external resource would add value beyond what's already generated
3. If `resource_decision.needed = true`, run the search step (video/article/tool lookup), filter for quality (reputable source, appropriate length, actual relevance to the concept — not just keyword match), and attach the single best result.
4. Resolve `image_source`: `type: stock` triggers a stock photo API call (Unsplash/Pexels); `type: generated` triggers an image-generation call, also routed through Vercel AI Gateway alongside the text models, so the image provider (Imagen, DALL-E, Flux, etc.) is likewise a config value, not hardcoded.
5. Persist to `tutorial_content` (see Feature 6 for cache key).

**Diagram reuse rule:** reuse the source's original diagram when it is clear, correctly labeled, and linked to this subtopic's section. Generate a fresh one when the original is missing, low quality (poor scan, illegible labels), or a different explanation angle would teach it better. This is a quality gate, not a fixed rule — implement as an explicit check (resolution/legibility heuristic + section-link confidence) rather than always-reuse or always-regenerate.

**Image sourcing rule:** try a stock photo search first — cheaper, faster, and avoids the slightly-off look of AI-generated "realistic" photos. Fall back to image generation only when no suitable stock photo exists — typically for abstract or illustrative concepts with no real-world equivalent to photograph. Never use a generative image model for the diagram itself — generative models render legible labels/text unreliably, which is why diagrams stay a separate, structured, code-rendered path.

**Provenance tracking:** whenever `diagram_spec` resolves to `{reuse: source_image_id}`, set `tutorial_content.provenance = reused_from_upload` (or `reused_from_topic_research`, for the Feature 2 path). Whenever the diagram is freshly generated instead, set `provenance = generated`. This flag is what Feature 14/17's publish gate checks — it has to be set here, at generation time, not inferred later, since by the time a course reaches publish there's no cheap way to tell whether a given diagram was lifted from the student's upload or produced from scratch.

**Data model:** `tutorial_content(id, subtopic_id, level, style_bucket, explanation, diagram_spec, image_source, example, resource_json, provenance, generated_at)` — `style_bucket` addition explained in Feature 6/18 below.

**Edge cases:**
- Resource search returns nothing suitable → `resource_decision.needed` should degrade to `false` rather than showing a weak/irrelevant result.
- Diagram generation fails or produces something incoherent → fall back to no diagram rather than showing a broken one; log for review.
- Image generation produces something off-topic, low quality, or fails → fall back to `image_source: {type: none}` rather than showing a bad image; don't retry indefinitely on the same request.

---

### 6. On-Demand Generation & Caching

**What it does:** Tutorial content generates the first time a subtopic is opened, not upfront for the whole course; cached after that.

**How it works:**
1. Client requests `GET /subtopics/{id}/tutorial`.
2. Server checks `tutorial_content` for a row matching the cache key (see below).
3. Cache hit → return immediately.
4. Cache miss → run Feature 5's generation pipeline synchronously (this is a fast-path request, typically a few seconds), write to cache, return.

**[RESOLVED — cache key extended to resolve the Feature 18 persona-fragmentation tension]** Cache key is now `subtopic_id + level + style_bucket`, not just `subtopic_id + level`:
- `style_bucket` defaults to a single shared value, `"neutral"`, for every student who hasn't picked a persona (Feature 18). This is the overwhelming majority of generation traffic, so the cohort-wide cost amortization this feature exists for is unchanged for most students.
- Only students who've actively selected a persona style get a non-`"neutral"` `style_bucket`. Per Feature 18's resolved approach, that bucket doesn't trigger a full independent regeneration — it reuses the `"neutral"` row's `explanation`/`diagram_spec`/`example` as a base and layers a cheap restyle rewrite on top (see Feature 18). The extra cache rows this creates are bounded by *actual persona demand*, not by the full space of possible styles.
- This directly resolves the tradeoff flagged earlier: shared-cache economics stay intact for the default path, and persona personalization no longer implicitly threatens to fragment the cache per style × subtopic × level.

**Cache key rule:** key on `subtopic_id + level + style_bucket`. Content generated once for a given subtopic/level/style serves every student in that bucket — this is what keeps generation cost sane at scale.

**Note — one half of this feature's tradeoff is intentionally not resolved here:** the persona-fragmentation risk is fixed above, but the other risk this cache design carries — a bad generation isn't a one-off, it's the canonical lesson served to a whole cohort until someone notices — has no fix within this file's scope. Catching that requires moderation/eval infrastructure (golden-set evals, output moderation before caching) that belongs to the LLM-handling doc, not a feature-spec-level change. Flagging this explicitly rather than letting it look resolved by omission.

**Edge cases:**
- Two students open the same uncached subtopic simultaneously → use a lock/in-flight marker on the cache row so the second request waits on the first's result instead of double-generating.
- A cache row for a non-`"neutral"` `style_bucket` is only ever created *after* the `"neutral"` row already exists for that `subtopic_id + level` — a persona request arriving before the base row exists triggers base generation first, synchronously, then the restyle layer. Prevents a persona student from ever accidentally becoming the one who pays for a full independent generation.

---

### 7. Module Quiz & Assessment

**What it does:** One quiz per module, after all its subtopics are complete, mixing recall and applied questions.

**How it works:**
1. Once all subtopics in a module are marked complete, the module quiz unlocks (client-side gate + server-side check on submit).
2. Quiz generation call produces N questions per module (mix of recall — direct definitions — and applied — scenario-based reasoning), each tagged with a `concept_id` from the subtopic's existing `subtopic_concepts` mapping (established in Feature 4) — the generation step selects from concepts already resolved for this module's subtopics, it does not invent new concept identities at quiz time.
3. On submission, each answer is graded and written to `quiz_attempts`; results feed Feature 8 (mastery update) per `concept_id`, not just per module as a whole.

**Data model:** `quiz_attempts(id, student_id, module_id, question, concept_id, answer, correct, timestamp)`. `concept_id` is a foreign key into `concepts` (Feature 4) — not a free-text field — so it joins cleanly against `mastery_scores.concept_id` with no fuzzy matching required at read time. Because Feature 4's `mergeConcepts()` reassigns this FK on merge, a quiz history stays queryable under the surviving concept even after a dedup merge runs.

**Edge cases:**
- Free-text answers (if used for applied questions) need LLM-graded scoring with a clear rubric rather than exact-match; store the grading rationale for potential dispute/review.

---

### 8. Adaptive Mastery Engine & Spaced Repetition

**What it does:** Tracks per-concept mastery over time, decays it, and schedules review of weak concepts.

**How it works:**
1. Each graded quiz answer (Feature 7) updates a `mastery_scores` row for that `student_id + concept_id`: correct answers raise the score, incorrect lower it.
2. A decay function reduces the score over time since `last_reviewed_at` (standard forgetting-curve model — e.g. exponential decay tied to days elapsed).
3. A scheduler job (periodic, e.g. daily) computes `next_review_at` per concept based on current score and decay rate, and surfaces due concepts the next time the student opens the app.
4. When a concept resurfaces, regenerate its explanation with an explicit "different angle" instruction (analogy instead of definition, worked example instead of prose) rather than replaying the same cached `tutorial_content` — this needs its own generation path distinct from Feature 5/6's first-pass cache, using the `regenerateTutorialContent()` method described in Feature 4 (structurally barred from touching `subtopic_concepts`).
5. If `courses.goal = exam_prep` and a deadline date exists, shrink the review interval as the date approaches (denser cramming cadence).

   **[RESOLVED — undefined field, pre-existing gap]** Neither the original spec nor Feature 3's intake step ever actually defined where this deadline comes from — Feature 3 only collects `goal`/`level`, not a date. Add `courses.exam_date` (nullable date), collected as an optional third field on the Feature 3 intake screen, shown only when `goal = exam_prep` is selected. Null means step 5's interval-shrinking logic simply doesn't apply (falls back to the standard decay-based schedule) — it isn't an error state.

**[RESOLVED — regeneration cost, mirrors Feature 6's cache logic]** The "different angle" regenerated explanation is cached and shared, not generated fresh per student:
- Cache key: `concept_id + level + angle_variant` (e.g. `analogy`, `worked_example`) in a new `concept_review_content` table — structurally separate from `tutorial_content` since it's keyed by `concept_id` (canonical, cross-subtopic) rather than `subtopic_id`.
- When a concept resurfaces for a student, the scheduler checks this cache before calling the LLM. Since review timing is driven by decay math that's similar across students studying the same concept at the same level, many students hitting review in the same window can share the same re-angled explanation instead of each triggering an independent generation call.
- `angle_variant` selection can rotate (so a student who reviews the same concept multiple times over months doesn't see the identical rewrite every time) while still hitting the cache on repeat rotations rather than generating something new each time.

**Data model:** `mastery_scores(student_id, concept_id, score, last_reviewed_at, next_review_at)`; new: `concept_review_content(id, concept_id, level, angle_variant, explanation, generated_at)`.

**Edge cases:**
- Concept tested across multiple modules (rare but possible) → mastery score should be per concept, not per module, so it aggregates correctly.
- Student never returns to review a due concept → no special handling needed beyond continuing decay; just don't force interruption.

---

### 9. Final Project

**What it does:** A real-world application exercise at the end of a course.

**How it works:**
1. On completion of the last module, generate a project prompt that ties multiple concepts from the course to a real, current scenario (e.g. "here's a real recent economic report — analyze it using elasticity and supply/demand").
2. Student submits a response (free text); optionally LLM-reviewed for feedback, not strict grading — this is meant to be reflective, not a gate.

**Data model:** Could reuse `quiz_attempts` with a `type = final_project` flag, or a dedicated `final_projects` table if richer feedback/versioning is needed.

**Edge cases:** None significant — lowest-risk feature in the core engine; treat as a straightforward generation + free-text submission.

---

## Part 2: Planned Features

### 10. In-Tutorial Q&A

**What it does:** A chat under each subtopic where the student asks about that exact concept and gets an answer grounded in it.

**How it works:**
1. Chat input sits below the tutorial content on the subtopic screen.
2. On submit, the request includes: the student's question + the full `tutorial_content` row for this subtopic (explanation, diagram spec, example) as context — not the whole course, just this subtopic.
3. LLM answers using that context; if the question clearly needs broader course context (e.g. references an earlier module), retrieve those additional chunks too rather than failing to answer.
4. Store the Q&A exchange, associated with `subtopic_id + student_id`, so it can inform Feature 8's picture of where the student is confused (a repeated question on the same subtopic is itself a mastery signal).

**[RESOLVED — cost scaling, Q&A has no shared cache the way tutorials do]** Before generating a new answer, check for a prior answered question on the same `subtopic_id` with high embedding similarity to the incoming question (across *all* students, not just this one — the point is catching the realistic case of many students independently asking near-identical things on a popular subtopic). If a sufficiently similar prior question exists above a similarity threshold, return that cached answer instead of calling the model again. This is stated here as a baseline behavior for Feature 10, not an optional optimization — Feature 10 as originally specced described an uncapped, per-question generation loop with zero cost control of its own, which doesn't hold up at scale the way Feature 6's cohort-shared tutorial cache does.

**Data model:** `qna_messages(id, subtopic_id, student_id, question, answer, timestamp)`; the similarity check above queries this table directly (embedding on `question`, scoped to `subtopic_id`) rather than requiring a separate cache table.

**Edge cases:**
- Off-topic questions → answer if reasonable, but don't let this become an open-ended general chat; keep scope anchored to the subject.

---

### 11. Visual Mastery Map

**What it does:** A full map of the course, color-coded by per-subtopic/module mastery, replacing a simple progress bar.

**How it works:**
1. Render every module/subtopic as a node; color derived directly from `mastery_scores` (e.g. red/amber/green thresholds).
2. Clicking a weak node jumps straight to that subtopic (or its next scheduled review, if already completed once) rather than requiring linear navigation.
3. Refreshes on every quiz submission and on each scheduled decay recompute (Feature 8), not just on page load — so it stays live.

**Data model:** Pure read/derived view over `mastery_scores` + `modules`/`subtopics`; no new storage needed beyond what Feature 8 already tracks.

**Edge cases:** Concepts not yet attempted should render as a distinct "not started" state, not lumped in with "weak."

---

### 12. Step-by-Step Practice Problems

**What it does:** Worked problems between tutorial and quiz, with progressive hints before the full solution.

**How it works:**
1. Generated alongside tutorial content (Feature 5) or on first request, for subtopics flagged as calculation/application-heavy (a flag set during module generation, Feature 4).
2. Each problem has an ordered hint list plus a final full solution; client reveals one hint per tap, never jumping straight to the solution unless requested.
3. Attempts can optionally feed `mastery_scores` the same way quiz answers do, since they're a real skill signal.

**[RESOLVED — manual override for a wrong auto-classification]** The calc-heavy flag is set once at module-generation time with no correction path in the original spec. Add `subtopics.practice_problems_override` (nullable boolean): `null` means "use the auto-generated flag," `true`/`false` explicitly overrides it. Settable by the student or teacher (teacher override takes precedence in classroom mode, Feature 19) from the subtopic view. The practice-problem generation check reads the override first, falling back to the auto-flag only when `null` — no regeneration pipeline needed, since this only gates whether the (cheap) generation step runs at all.

**Data model:** `practice_problems(id, subtopic_id, problem_text, hints_json, solution)`; attempts logged similarly to `quiz_attempts`. `subtopics.practice_problems_override` (nullable boolean, new).

**Edge cases:** Not every subject needs this — gate it on the calculation-heavy flag (or its override) rather than generating for every subtopic regardless of relevance.

---

### 13. Export to External Tools

**What it does:** Flashcards export to Anki; modules export as notes to PDF/Notion.

**How it works:**
1. Anki export: generate a `.apkg` (or plain CSV import-compatible format) from the flashcard set tied to a module's subtopics.
2. PDF export: render a module's tutorials (explanation + diagrams + examples) into a clean formatted document.
3. Notion export: use Notion's API to create a page per module with the same content, if the student has connected a Notion account.

**Data model:** No new storage; this is a read-and-transform operation over existing `tutorial_content` and any flashcard-specific fields (flashcards could live as a derived field within `tutorial_content` or a dedicated `flashcards` table keyed by subtopic).

**Edge cases:** Diagrams (SVG) need to rasterize cleanly for PDF/Anki export — verify rendering fidelity outside the web context before shipping this.

---

### 14. Public Course Sharing

**What it does:** A student can publish a completed course so others can read it free.

**How it works:**
1. On course completion, offer a "publish" action.
2. **Copyright/provenance gate:**

   **[RESOLVED — publish-time re-scan cost]** The gate no longer re-scans every `tutorial_content` row in the course on every publish attempt. Add `courses.publish_gate_checked_at` (nullable timestamp). On a publish attempt:
   - If `publish_gate_checked_at` is null (first attempt ever), run the full scan described below over every `tutorial_content` row in the course.
   - On any subsequent attempt, scan only rows where `tutorial_content.generated_at > courses.publish_gate_checked_at` — i.e. only content created or regenerated since the last check. Rows already cleared don't need re-checking, since `provenance` is immutable once set (Feature 5) and doesn't change on its own between checks.
   - On a clean pass (nothing blocking), set `publish_gate_checked_at = now()` regardless of whether this was a full or incremental scan.

   The check itself: look for `provenance = reused_from_upload` where the underlying `source_documents.license_status = user_uploaded_unknown`. If any exist (in the scanned set):
   - Block publish, and surface which specific subtopics are blocking it.
   - Give the student two paths to clear the block: regenerate those subtopics without diagram reuse (`provenance` becomes `generated`), or provide an explicit rights attestation covering the source material, captured as `courses.publish_attestation_at` tied to the account — not a checkbox that vanishes after submission. (Feature 1's early-attestation option, above, can pre-populate this field before publish is even attempted.)
   - Courses sourced entirely from the Topic-Only path (Feature 2) default to publishable, since `source_documents.license_status = open_license` there.

3. Publish sets `courses.visibility = public`, adds to a search index (subject, level, goal tags already stored on the course).
4. Public courses are read-only for non-owners — serve the same `tutorial_content` rows, no regeneration per viewer.
5. **[RESOLVED — "taking" vs. "reading" fork, was a recommendation, now the actual spec]** Non-owner viewers can read but don't get `mastery_scores`, `qna_messages`, or spaced-review scheduling by default. A viewer who chooses to start "taking" the course (not just reading) triggers a lightweight fork:
   - New table: `course_forks(id, original_course_id, student_id, created_at)`.
   - The forking student's `mastery_scores` and `quiz_attempts` rows are tagged against the fork (via `course_forks.id` referenced on those rows, or a `fork_id` FK column added to both) rather than against the original `course_id` directly — this is what keeps a popular public course from accumulating every reading student's mastery data under one shared course record.
   - No `tutorial_content` is duplicated — the fork is a progress-tracking record, not a content copy. All forks of the same original course continue reading the same underlying `modules`/`subtopics`/`tutorial_content` rows.
6. Add a report/flag action on public courses; flagged courses get pulled from the public index pending review.
7. **Minor accounts cannot publish** (see Feature 19's compliance section) — the publish action is unavailable on any account with `age_bracket != adult`, independent of the copyright gate above.

**Data model:** `courses.visibility`, `courses.published_at`, `courses.publish_attestation_at`, `courses.publish_gate_checked_at` (new); `course_reports(id, course_id, reporter_id, reason)` for moderation; `course_forks(id, original_course_id, student_id, created_at)` (new, per above).

**Edge cases:**
- A course still being actively edited/regenerated by its owner after publish could theoretically fall behind `publish_gate_checked_at` if a regeneration back-dates `generated_at` — regeneration should always set `generated_at = now()` on write (already implied by "regeneration" as a concept) so the incremental scan can't miss a row.

---

## Part 3: Business & Growth Features

### 15. Cross-Course Knowledge Linking

**What it does:** If a student already mastered a concept in one course, a later course touching the same concept links back rather than re-teaching from scratch.

**How it works:**
1. This feature is now a straightforward consumer of the `concepts` table and `subtopic_concepts` mapping established in Feature 4 — cross-course matching is a lookup on `concept_id`, not a fuzzy re-derivation per course.
2. When generating a new course's modules, after concept resolution (Feature 4, step 4) check the student's existing `mastery_scores` for overlapping `concept_id`s; if a strong match exists (high mastery score, recently reviewed), mark that subtopic as "already known" and offer a skip/link-back option instead of generating a full fresh tutorial.
3. Requires Feature 4's generation step to accept an additional input: the student's existing mastery map, not just the source material.

**Data model:** No new tables — this feature reads `concepts`, `subtopic_concepts`, and `mastery_scores` as already defined in Feature 4/8.

**Edge cases:** This feature's reliability now depends on the resolved three-tier matching + merge process in Feature 4, rather than an unresolved fuzzy-match gap — a concept sitting in `pending_review` still resolves to a real (if possibly-duplicate) `concept_id`, so cross-course matching degrades gracefully to "might miss a link until the duplicate is merged" rather than failing outright.

---

### 16. Verified Completion / Shareable Certificate

**What it does:** A shareable proof-of-completion at course end.

**How it works:**
1. On course completion (all modules + final project done), generate a certificate record: student name, course subject, completion date, level.
2. Render as a shareable image/PDF and a public verification URL (so it can be posted to LinkedIn and verified by anyone who clicks through).
3. Gate full certificate generation behind a paid tier if monetizing this directly; free tier could still show "completed" status without the shareable artifact.

**[RESOLVED — certificate trust question, was raised and left open]** Add `certificates.course_type` (enum: `ai_generated | instructor_verified`) now, even though only `ai_generated` is populated in v1 (every course today is AI-generated; instructor-verified courses don't exist yet). This costs nothing today — it's a single enum column set to a constant on insert — and avoids a schema migration plus a scramble over trust-messaging later, once/if instructor-verified courses (e.g. reviewed Marketplace courses, Feature 17) become a real category worth distinguishing on the certificate itself.

**Data model:** `certificates(id, student_id, course_id, issued_at, verification_slug, course_type)`.

**Edge cases:** None further — the open trust question is resolved by making the distinction structurally available now rather than deciding policy on it yet; whether/how to surface `course_type` on the public verification page is a UI decision that can be made independently, later, without another migration.

---

### 17. Course Marketplace

**What it does:** Experts/teachers build and sell premium hand-curated courses.

**How it works:**
1. A creator uses the same course-building tools (upload/topic path, module/subtopic generation) but with an editing layer to manually refine AI-generated content before publishing.
2. The same copyright/provenance gate from Feature 14 applies here and is stricter: the manual review step required before a paid course goes live must explicitly check for `provenance = reused_from_upload` content with `license_status = user_uploaded_unknown` as a hard checklist item, not left to reviewer judgment — money changing hands raises the stakes of getting this wrong.
3. Publish flow adds a `price` field and a payment/checkout step (Stripe or similar) instead of Feature 14's free-publish flow.
4. Platform takes a percentage cut on each sale; creator gets a payout dashboard.
5. The `creator` role is unavailable to accounts with `age_bracket != adult` (see Feature 19) — minors cannot list paid courses.

**[RESOLVED — manual review is a human bottleneck that doesn't scale with creator growth]** The review step stays human (money changing hands genuinely warrants judgment, so this isn't automated away), but it's no longer an unbounded queue:
- New table: `marketplace_review_queue(id, course_id, creator_id, submitted_at, sla_due_at, status, assigned_reviewer_id)`. `sla_due_at` is set to `submitted_at + 72h` on insert.
- A scheduled job checks for rows where `status = pending` and `sla_due_at < now()`; any match triggers an auto-escalation notification (admin channel/alert) rather than sitting silently. This doesn't remove the human bottleneck, but it converts an invisible backlog into a visible, alertable one — the same shape of fix applied to Feature 4's concept-dedup queue below.
- The copyright checklist item from step 2 above is a required field on this queue row (`copyright_checklist_passed: boolean`, not nullable) — a reviewer cannot mark a course `approved` without explicitly setting this, closing the "left to reviewer judgment" gap.

**[RESOLVED — undefined role, pre-existing gap]** `assigned_reviewer_id` here (and the "admin dedup screen" in Feature 4's `concept_review_candidates`) both assume a reviewer/admin identity that doesn't exist — the project's auth roles are `student | teacher | creator` only (per the project-structure doc's AuthModule). Add `admin` as a fourth role value on the same role enum, gated to internal accounts only (not self-serve signup — provisioned manually or via an internal invite flow, out of scope for this doc to detail further). `assigned_reviewer_id` and `concept_review_candidates.reviewed_by` both FK to `users.id` where `role = admin`.

**Data model:** `courses.price`, `courses.creator_payout_pct`; `purchases(id, course_id, buyer_id, amount, timestamp)`; `marketplace_review_queue(id, course_id, creator_id, submitted_at, sla_due_at, status, assigned_reviewer_id, copyright_checklist_passed)` (new); `users.role` gains `admin` as a fourth value.

**Edge cases:**
- Needs its own moderation/quality bar distinct from Feature 14's free public courses, since money is changing hands — the SLA-bound queue above is that bar's operational backbone.
- Stock/generated image licensing terms (Unsplash/Pexels, and whichever image-gen provider is routed through the AI Gateway) need a legal read specifically for monetized use before this feature ships — those licenses are typically written for editorial/non-commercial use and may not cleanly cover content sold to a buyer.

---

### 18. Explain-It-Your-Way Personas

**What it does:** A student picks an explanation style (e.g. sports analogies, cooking analogies) applied consistently across every subject.

**How it works:**
1. Student selects a persona/style preference once, stored on their profile (`users.explanation_style`).
2. Every tutorial generation call (Feature 5) includes this preference as a prompt parameter, steering analogy choice and phrasing.
3. **[RESOLVED — cache fragmentation, now the actual spec rather than a suggested approach]** Feature 6's cache is keyed on `subtopic_id + level + style_bucket` (see Feature 6). A student's selected persona maps to a `style_bucket` value; the *expensive* base generation (`explanation`, `diagram_spec`, `example`) is generated and cached exactly once per `subtopic_id + level` under the `"neutral"` bucket, regardless of how many persona styles exist. Persona-styled content is a lightweight per-style rewrite layered on top of that shared base — regenerating only the analogy-flavored framing, not the underlying explanation/diagram/example — and that restyle layer is what actually gets cached under the non-`"neutral"` `style_bucket`. This is cheaper than a fully separate cache entry per style by construction, and it's bounded: a `style_bucket` cache row for a given style only gets created the first time a real student with that persona opens that subtopic — never pre-generated for all possible styles up front.

**Data model:** `users.explanation_style`; `tutorial_content.style_bucket` (Feature 5/6) is the caching mechanism described above.

**Edge cases:** The fragmentation risk originally flagged here is resolved structurally (bounded by real demand, base generation shared) rather than left as a design principle to remember during implementation.

---

### 19. Teacher / Classroom Mode

**What it does:** A teacher uploads a syllabus once; every student in the class gets their own adaptive version; the teacher sees an aggregated view of class-wide weak spots.

**How it works:**
1. Teacher account creates a course via the Upload Path (Feature 1), then invites students (via a class code or roster upload) rather than students each uploading their own copy.
2. Each invited student gets their own `course` instance (or a lightweight per-student progress fork — reusing the same `course_forks` mechanism resolved in Feature 14, rather than a second bespoke forking system) tied to the same underlying `source_documents`/`source_chunks` — content generation stays shared (same cache keys), but `mastery_scores` and `quiz_attempts` are tracked per student.
3. Teacher dashboard aggregates `mastery_scores` and `quiz_attempts` across all students in the class, anonymized per-student but rolled up per concept — e.g. "62% of the class is weak on Elasticity."
4. This is the primary paid B2B surface — pricing likely per classroom/seat rather than per student.

**[RESOLVED — consent model, was flagged as a blocking open fork]** School/teacher-mediated consent is the committed v1 default, not an open decision — direct parental consent (needed for self-serve sales to individual classrooms without an institutional agreement) is explicitly scoped as a **Phase 2** feature, not a parallel path to design now. This removes the ambiguity that made the decision "blocking": v1 ships against a single consent model.

1. Classroom creation requires the inviting teacher/institution to attest that consent is handled, logged against the classroom record (`classrooms.consent_on_file`, `classrooms.consent_document_url`) — a minor student joining via class code is not, by itself, meaningful consent.
2. Every account created via classroom invite is tagged `users.age_bracket = minor_school_consented`, distinct from the general self-serve signup path.
3. Any account with `age_bracket != adult` gets stricter behavior enforced automatically, not left as teacher configuration:
   - **In-Tutorial Q&A (Feature 10)** gets an actual enforced topic-scope check — an off-topic classifier step runs before the answer is generated, with a hard refuse-and-redirect on a miss, not just a prompt instruction asking the model to stay on topic.
   - **Public Course Sharing (Feature 14) and Marketplace (Feature 17)** are disabled outright — no publish action, no creator role — rather than relying on the same copyright/review gates used for adult accounts.
   - **Analytics (PostHog)** must exclude minor accounts' events from any B2B-facing analytics stream or dashboard export — this is exactly the surface where the temptation to instrument everything for the paying customer (the school) is highest, and exactly where it's most restricted.
4. **[RESOLVED — self-serve age-unknown UX cost]** Self-serve (non-classroom) signup has no reliable way to know a user's age. Birthdate collection is a **soft, skippable, single-tap step at signup** — not a blocking form field — with a one-line reason shown inline ("unlocks publishing and sharing"). An account that skips it gets `age_bracket = unknown` and degrades to the same minor-safe defaults above until resolved; the account isn't blocked from using the app, only from publish/marketplace/relaxed-Q&A-scope behavior. Never default an unresolved account to `adult`. This keeps the safety default intact while minimizing how many genuine adults sit needlessly in restricted mode — they can resolve it in one tap whenever they hit a wall (e.g. attempting to publish), rather than being forced through it up front.

**[RESOLVED — fork/dashboard linkage was never wired]** Reusing `course_forks` (Feature 14) for per-student classroom progress only works if the teacher dashboard can actually join from a classroom roster to the right fork's `quiz_attempts`. Add `classroom_students.fork_id` (FK → `course_forks.id`, set at invite-acceptance time when the student's fork is created).

**Correction — `mastery_scores` and `quiz_attempts` do not share a join path.** An earlier version of this note said the dashboard joins both tables via `fork_id`. That's only true for `quiz_attempts` — each attempt is legitimately scoped to one student's one course instance, so it carries a `fork_id`. `mastery_scores` is deliberately **not** fork-scoped: it's keyed globally per `(student_id, concept_id)` with no `course_id`/`fork_id` at all, because Feature 15 (cross-course knowledge linking) requires a student's mastery of a given concept to be one shared score across every course/fork that touches it — scoping it to a fork would fragment that and break Feature 15 outright. So the dashboard query uses two different join paths:
- `quiz_attempts` → join to `classroom_students` via `fork_id`.
- `mastery_scores` → join to `classroom_students` via `student_id` directly, then scope to *this* classroom's course by filtering to the `concept_id`s reachable from `classrooms.course_id` (via `modules → subtopics → subtopic_concepts`), not by fork.

**Data model:** `classrooms(id, teacher_id, course_id, consent_on_file, consent_document_url)`, `classroom_students(classroom_id, student_id, fork_id)` (new column), `users.age_bracket` (enum: `adult | minor_school_consented | unknown`); dashboard is a read/aggregate view combining `quiz_attempts` (joined through `classroom_students.fork_id` → `course_forks.id`) and `mastery_scores` (joined through `classroom_students.student_id`, scoped by the classroom's concept set — see correction above). Per-student progress uses `course_forks` (Feature 14) rather than a separate fork table.

**Edge cases:** Privacy — the teacher view must stay aggregated/anonymized by default; decide explicitly whether a teacher can ever see an individual student's specific wrong answers (likely yes for a real classroom tool, but should be a deliberate, disclosed feature, not implicit).

---

## Summary of new/changed data model from this resolution pass

| Table/field | Feature | Purpose |
|---|---|---|
| `concepts.match_status`, `concepts.merged_into` | 4 | Three-tier resolution outcome + merge soft-delete |
| `concept_review_candidates` | 4 | Actionable concept-dedup queue |
| `courses.level_changed_at` | 3 | Marks scope of mid-course level changes |
| `tutorial_content.style_bucket` | 5, 6, 18 | Extends cache key to resolve persona fragmentation |
| `concept_review_content` | 8 | Shared cache for spaced-repetition "different angle" regenerations |
| `courses.publish_gate_checked_at` | 14 | Enables incremental (not full-scan) copyright gate checks |
| `course_forks` | 14, 19 | Unified lightweight fork mechanism for "taking" a public course or classroom per-student progress |
| `certificates.course_type` | 16 | Future-proofs AI-generated vs. instructor-verified trust distinction |
| `marketplace_review_queue` | 17 | SLA-bound, escalating human review queue |
| `subtopics.practice_problems_override` | 12 | Manual correction for the calc-heavy auto-flag |
| `courses.exam_date` | 3, 8 | Defines the previously-undefined exam_prep deadline Feature 8 relied on |
| `classroom_students.fork_id` | 19 | Wires the teacher dashboard join to the correct `course_forks` row |
| `users.role` gains `admin` | 4, 17 | Defines the reviewer identity `assigned_reviewer_id`/`reviewed_by` assumed but never declared |

---

*Next: the LLM-handling doc (memory, cost, guardrails, evals, reliability, observability) covers the mechanics underneath several of the above — e.g. Feature 10's semantic-cache check and Feature 6/18's caching both assume the embedding-similarity infrastructure detailed there. That doc's own bottlenecks/tradeoffs are addressed separately.*
