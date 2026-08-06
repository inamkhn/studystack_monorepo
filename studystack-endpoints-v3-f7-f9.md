# StudyStack — Endpoint Stubs: F7 (Module Quiz & Assessment), F9 (Final Project)

Continues from `studystack-endpoints-v2.md` (Auth, F1–3, F4–6, F4 expanded, F15). Both features below live in `AssessmentModule`, sharing `quiz_attempts`-adjacent data — grouped together per the project-structure doc's module ownership.

Method, path, and a 1–2 line description only — no request/response bodies, DTOs, or implementation.

---

## AssessmentModule — F7 (Module Quiz & Assessment)

`GET /modules/:id/quiz`
Returns this module's quiz, generating it on first request. Each question is tagged with a `concept_id` selected from the module's existing `subtopic_concepts` mappings (Feature 4) — generation does not invent new concept identities.

`POST /modules/:id/quiz/submit`
Accepts the student's answers; server-side gate here confirms every subtopic in the module is marked complete before grading proceeds (Feature 7's stated check — *"client-side gate + server-side check on submit"*). Grades each answer (exact-match for recall questions, LLM-graded against a rubric for free-text applied questions — rationale stored for dispute/review), writes one `quiz_attempts` row per question (`type = module_quiz`, `concept_id` carried from the question), and triggers Feature 8's mastery update per `concept_id`. In classroom mode, the written rows carry the student's `fork_id` (Feature 19), same as any other `quiz_attempts` write.

**Two open questions, not resolved by the feature spec — flagging rather than assuming:**
- Feature 7 never states whether quiz content is shared cross-student the way Feature 6's tutorial cache is, or generated fresh per student on each `GET`. That materially changes this endpoint's cost profile and whether a "regenerate" action ever makes sense.
- The spec ties the server-side completion check specifically to *submit*, not to `GET`/generation. Whether `GET` should also be gated — so a student can't fetch/preview quiz questions before finishing the module's subtopics — is a real design decision left open, not something either endpoint above should be assumed to already handle. (An earlier draft of this stub incorrectly stated `GET` was gated "mirroring the client-side gate" — that wasn't actually specified anywhere and has been removed.)

Both are worth resolving before implementation — if quiz content should be cached, the cache key (`module_id` alone? `module_id + level`? per-student for anti-predictability?) needs the same explicit treatment Feature 6 got; if `GET` should be gated, that gate needs its own spec sentence the way submit's does.

**Data model:** `quiz_attempts(id, student_id, module_id, concept_id, fork_id, type, question, answer, correct, timestamp)` — as defined in the schema; `type` distinguishes `module_quiz` from `final_project` below.

---

## AssessmentModule — F9 (Final Project)

`GET /courses/:id/final-project`
Returns the course's final project prompt, generating it on first request once the last module is complete — ties multiple concepts from across the course to a real, current scenario.

`POST /courses/:id/final-project/submit`
Accepts the student's free-text response; writes a `quiz_attempts` row (`type = final_project`, `concept_id = null` since it spans multiple concepts rather than tagging one) and optionally runs an LLM review pass for reflective feedback — not strict grading, per the feature spec's "lowest-risk feature in the core engine" framing.

**Data model:** Reuses `quiz_attempts` with `type = final_project` — the features doc left this as an open choice against a dedicated `final_projects` table, but the schema has already settled it via the `QuizAttemptType` enum (`module_quiz | final_project`), so no new storage is needed here.
