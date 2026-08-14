// ─────────────────────────────────────────────────────────────────────────
// @studystack/types — shared Zod schemas + inferred TypeScript types
// Both web and api import from here; never redefine types independently.
// ─────────────────────────────────────────────────────────────────────────

import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────

export const RoleEnum = z.enum(["student", "teacher", "creator", "admin"]);
export type Role = z.infer<typeof RoleEnum>;

export const AgeBracketEnum = z.enum([
  "adult",
  "minor_school_consented",
  "unknown",
]);
export type AgeBracket = z.infer<typeof AgeBracketEnum>;

export const ExplanationStyleEnum = z.enum([
  "neutral",
  "sports",
  "pop_culture",
  "historical",
  "cooking",
  "sci_fi",
]);
export type ExplanationStyle = z.infer<typeof ExplanationStyleEnum>;

export const CourseSourceTypeEnum = z.enum(["upload", "topic"]);
export type CourseSourceType = z.infer<typeof CourseSourceTypeEnum>;

export const CourseStatusEnum = z.enum([
  "intake_pending",
  "ingesting",
  "structuring",
  "ready",
  "failed",
]);
export type CourseStatus = z.infer<typeof CourseStatusEnum>;

export const GoalEnum = z.enum(["class", "exam_prep", "curiosity"]);
export type Goal = z.infer<typeof GoalEnum>;

export const LevelEnum = z.enum(["beginner", "some_background"]);
export type Level = z.infer<typeof LevelEnum>;

export const CourseVisibilityEnum = z.enum(["private", "public_shared"]);
export type CourseVisibility = z.infer<typeof CourseVisibilityEnum>;

export const LicenseStatusEnum = z.enum([
  "user_uploaded_unknown",
  "open_license",
]);
export type LicenseStatus = z.infer<typeof LicenseStatusEnum>;

export const ContentProvenanceEnum = z.enum([
  "reused_from_upload",
  "reused_from_topic_research",
  "generated",
]);
export type ContentProvenance = z.infer<typeof ContentProvenanceEnum>;

export const ConceptMatchStatusEnum = z.enum([
  "confident",
  "pending_review",
  "resolved",
]);
export type ConceptMatchStatus = z.infer<typeof ConceptMatchStatusEnum>;

export const ConceptReviewStatusEnum = z.enum([
  "pending_review",
  "resolved_merged",
  "dismissed",
]);
export type ConceptReviewStatus = z.infer<typeof ConceptReviewStatusEnum>;

export const QuizAttemptTypeEnum = z.enum(["module_quiz", "final_project"]);
export type QuizAttemptType = z.infer<typeof QuizAttemptTypeEnum>;

export const CertificateCourseTypeEnum = z.enum([
  "ai_generated",
  "instructor_verified",
]);
export type CertificateCourseType = z.infer<typeof CertificateCourseTypeEnum>;

export const MarketplaceReviewStatusEnum = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type MarketplaceReviewStatus = z.infer<
  typeof MarketplaceReviewStatusEnum
>;

// ── Core entity schemas (placeholder — expanded as features are built) ────

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  role: RoleEnum,
  ageBracket: AgeBracketEnum,
  explanationStyle: ExplanationStyleEnum.nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

export const CourseSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  sourceType: CourseSourceTypeEnum,
  topic: z.string().nullable().optional(),
  title: z.string(),
  status: CourseStatusEnum,
  goal: GoalEnum.nullable().optional(),
  level: LevelEnum.nullable().optional(),
  examDate: z.coerce.date().nullable().optional(),
  visibility: CourseVisibilityEnum,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Course = z.infer<typeof CourseSchema>;

export const ModuleSchema = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  order: z.number().int(),
  title: z.string(),
  createdAt: z.coerce.date(),
});
export type Module = z.infer<typeof ModuleSchema>;

export const SubtopicSchema = z.object({
  id: z.string().uuid(),
  moduleId: z.string().uuid(),
  order: z.number().int(),
  title: z.string(),
  createdAt: z.coerce.date(),
});
export type Subtopic = z.infer<typeof SubtopicSchema>;

export const ConceptSchema = z.object({
  id: z.string().uuid(),
  canonicalName: z.string(),
  subjectArea: z.string(),
  aliases: z.array(z.string()),
  matchStatus: ConceptMatchStatusEnum,
  mergedIntoId: z.string().uuid().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type Concept = z.infer<typeof ConceptSchema>;

// ── F4 structuring — LLM structured-output contract ────────────────────
// The module/subtopic/concept structure the frontier model must return for
// a course (validated via withStructuredOutput before anything is written).
// Array caps are part of the cost bounding — they limit how much a crafted
// upload can inflate the generation output.

export const StructureConceptSchema = z.object({
  canonicalName: z.string().min(1).max(80),
  aliases: z.array(z.string().max(80)).max(6).default([]),
});
export type StructureConcept = z.infer<typeof StructureConceptSchema>;

export const StructureSubtopicSchema = z.object({
  title: z.string().min(1).max(160),
  // F12: calc/application-heavy subtopics get practice problems.
  calcHeavy: z.boolean().default(false),
  concepts: z.array(StructureConceptSchema).min(1).max(12),
});
export type StructureSubtopic = z.infer<typeof StructureSubtopicSchema>;

export const StructureModuleSchema = z.object({
  title: z.string().min(1).max(160),
  subtopics: z.array(StructureSubtopicSchema).min(1).max(10),
});
export type StructureModule = z.infer<typeof StructureModuleSchema>;

export const CourseStructureSchema = z.object({
  subjectArea: z.string().min(1).max(80),
  modules: z.array(StructureModuleSchema).min(1).max(12),
});
export type CourseStructure = z.infer<typeof CourseStructureSchema>;
