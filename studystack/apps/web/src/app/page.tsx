import type { ReactNode } from "react";
import Link from "next/link";

import {
  IconArrowRight,
  IconBranch,
  IconCheck,
  IconClock,
  IconFile,
  IconLayers,
  IconLightbulb,
  IconShield,
  IconSparkles,
  IconStore,
  IconTarget,
} from "@/components/icons";
import { Logo } from "@/components/logo";
import { CourseStructureMock } from "@/components/landing/course-structure-mock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";

export default function LandingPage() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-component focus:bg-primary focus:px-4 focus:py-2 focus:text-label-md focus:text-on-primary"
      >
        Skip to content
      </a>

      <SiteHeader />

      <main id="main" className="flex-1">
        <Hero />
        <HowItWorks />
        <Features />
        <MasteryPreview />
        <Integrity />
        <FinalCta />
      </main>

      <SiteFooter />
    </>
  );
}

/* ── Header ──────────────────────────────────────────────────────────── */

const navLinks = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#mastery", label: "Mastery" },
  { href: "#integrity", label: "Integrity" },
];

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40">
      <div className="glass-1 border-x-0 border-t-0">
        <div className="layout flex h-16 items-center justify-between gap-4">
          <Link href="/" aria-label="StudyStack home">
            <Logo />
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-body-md text-ink-subtle transition-colors hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <Button href="/login" variant="subtle" size="sm" className="hidden sm:inline-flex">
              Log in
            </Button>
            <Button href="/signup" size="sm">
              Get started
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Level 0 canvas: fine mesh + ambient indigo focal glow */}
      <div aria-hidden className="bg-grid absolute inset-0" />
      <div aria-hidden className="aurora absolute -top-40 left-1/2 h-[42rem] w-[42rem] -translate-x-1/2" />

      <div className="layout relative grid items-center gap-14 py-20 lg:grid-cols-2 lg:py-28">
        <div>
          <Badge dotColor="bg-telemetry">ai course engine</Badge>

          <h1 className="mt-5 text-display-hero-mobile md:text-display-hero">
            Your documents,
            <br />
            turned into <span className="text-primary">mastery</span>.
          </h1>

          <p className="mt-6 max-w-xl text-body-xl text-ink-subtle">
            Upload a textbook, lecture notes or past papers. StudyStack structures them
            into modules, writes tutorials at your level, drills you with quizzes and
            flashcards, and tracks what you actually retain.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button href="/signup" size="lg">
              Start with your first document
              <IconArrowRight className="h-4 w-4" />
            </Button>
            <Button href="#how-it-works" variant="secondary" size="lg">
              See how it works
            </Button>
          </div>

          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            {["PDF, DOCX & scans", "Mastery tracking", "Exam-prep aware"].map((t) => (
              <li key={t} className="flex items-center gap-2 text-body-md text-ink-muted">
                <IconCheck className="h-4 w-4 text-mastery" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <CourseStructureMock />
      </div>
    </section>
  );
}

/* ── How it works ────────────────────────────────────────────────────── */

const steps = [
  {
    icon: IconFile,
    kicker: "01 · ingest",
    title: "Drop in real material",
    body: "Textbook chapters, your own notes, stacks of past papers — up to 50 MB per file, parsed with the source kept intact.",
  },
  {
    icon: IconBranch,
    kicker: "02 · structure",
    title: "Get a course backbone",
    body: "Modules, subtopics and a concept graph — shared ideas are linked across your courses, not relearned from scratch.",
  },
  {
    icon: IconSparkles,
    kicker: "03 · learn",
    title: "Learn adaptively",
    body: "Tutorials regenerate at your explanation level and style, backed by quizzes, flashcards and spaced revision.",
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-line py-20 lg:py-24">
      <div className="layout">
        <SectionHeading
          eyebrow="how it works"
          title="From raw PDF to revision in three steps"
          lede="No prompt gymnastics. The material you already own drives everything."
        />
        <ol className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.kicker}
              className="glass-1 rounded-card p-6 transition duration-300 hover:border-primary/25"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-component border border-primary/25 bg-primary/10 text-primary">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="text-label-sm uppercase text-ink-subtle">{s.kicker}</span>
              </div>
              <h3 className="mt-4 text-headline-md">{s.title}</h3>
              <p className="mt-2 text-body-lg text-ink-subtle">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ── Features ────────────────────────────────────────────────────────── */

const features = [
  {
    icon: IconLayers,
    title: "Concept graph",
    body: "Ideas that appear in more than one course merge into a single node with one mastery score — visible as an explorable graph.",
  },
  {
    icon: IconLightbulb,
    title: "Adaptive tutorials",
    body: "Every subtopic explains itself at first-pass, confident or exam-ready depth — in the style that suits you.",
  },
  {
    icon: IconTarget,
    title: "Quizzes & flashcards",
    body: "Assessment generated from your syllabus, not the web at large. Spaced-revision queues keep weak spots warm.",
  },
  {
    icon: IconClock,
    title: "Exam mode",
    body: "Set an exam date and StudyStack paces coverage against the calendar, prioritising what your retention says is slipping.",
  },
  {
    icon: IconStore,
    title: "Marketplace & forks",
    body: "Publish a course you built; fork someone's structure and get your own copy — progress, uploads and privacy stay separate.",
  },
  {
    icon: IconShield,
    title: "Guarded by design",
    body: "Rights attestation on upload, a provenance gate before anything goes public, and age-aware content controls.",
  },
];

function Features() {
  return (
    <section id="features" className="border-t border-line py-20 lg:py-24">
      <div className="layout">
        <SectionHeading
          eyebrow="features"
          title="A study system, not a chat window"
          lede="Built around retention mechanics rather than one-shot answers."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className="group rounded-card border border-line bg-surface/60 p-6 transition duration-300 hover:border-primary/30 hover:bg-surface"
            >
              <span className="grid h-10 w-10 place-items-center rounded-component border border-line bg-canvas/60 text-ink-subtle transition-colors group-hover:border-primary/30 group-hover:text-primary">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-headline-sm">{f.title}</h3>
              <p className="mt-2 text-body-md text-ink-subtle">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Mastery preview ─────────────────────────────────────────────────── */

const retention = [
  { topic: "Lewis structures", score: 94 },
  { topic: "Kinetics rate laws", score: 78 },
  { topic: "Aromatic substitution", score: 45 },
  { topic: "¹H NMR splitting", score: 21 },
];

function MasteryPreview() {
  return (
    <section id="mastery" className="border-t border-line py-20 lg:py-24">
      <div className="layout grid items-center gap-14 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="mastery telemetry"
            title="Know the difference between read and retained"
            lede="Every recall attempt moves a score. The mastery map aggregates them per concept — across courses, across subjects — so revision time goes where it actually changes something."
          />
          <ul className="mt-8 space-y-3">
            {[
              "Per-concept scores, merged across every course that teaches it",
              "Confidence-based scheduling queues the next review for you",
              "Course, module and concept rollups — macro and micro views",
            ].map((t) => (
              <li key={t} className="flex items-start gap-3 text-body-lg text-ink-muted">
                <IconCheck className="mt-1 h-4 w-4 shrink-0 text-mastery" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="glass-1 rounded-frame p-6">
          <div className="flex items-center justify-between">
            <p className="text-label-sm uppercase text-ink-subtle">retention · this week</p>
            <Badge dotColor="bg-mastery">live</Badge>
          </div>
          <div className="mt-6 space-y-5">
            {retention.map((r) => (
              <div key={r.topic}>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-body-md text-ink-muted">{r.topic}</p>
                  <p className="text-label-lg tabular-nums text-ink">{r.score}%</p>
                </div>
                <div className="track mt-2 h-1.5 overflow-hidden rounded-full">
                  <div
                    className="mastery-fill h-full rounded-full"
                    style={{ width: `${r.score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 border-t border-line pt-4 text-label-sm text-ink-subtle">
            next review queued · 3 flashcards · 1 weak concept
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Integrity ───────────────────────────────────────────────────────── */

function Integrity() {
  return (
    <section id="integrity" className="border-t border-line py-20 lg:py-24">
      <div className="layout">
        <div className="glass-1 rounded-frame bg-grid px-6 py-12 sm:px-10 lg:px-14">
          <div className="grid items-start gap-10 lg:grid-cols-[3fr_2fr]">
            <div>
              <SectionHeading
                align="left"
                eyebrow="academic integrity"
                title="The engine proves where knowledge came from"
                lede="Uploading requires a rights attestation. Before a course can go public, a provenance gate scans every tutorial for reuse of unverified material — what can't be traced gets held back."
              />
            </div>
            <ul className="space-y-4 pt-1">
              {[
                "Rights attestation gates every upload",
                "Provenance check before any public publish",
                "Forks copy structure, never your source files",
                "Age-aware controls on sensitive topics",
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-body-lg text-ink-muted">
                  <IconShield className="mt-1 h-4 w-4 shrink-0 text-primary" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Final CTA ───────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-line py-24">
      <div aria-hidden className="aurora absolute inset-x-0 -bottom-64 mx-auto h-[36rem] w-[36rem]" />
      <div className="layout relative">
        <SectionHeading
          eyebrow="get started"
          title="Start with the hardest thing you're studying this week"
          lede="One document is enough to see the whole pipeline: structure, tutorial, quiz, mastery map."
        />
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Button href="/signup" size="lg">
            Create your first course
            <IconArrowRight className="h-4 w-4" />
          </Button>
          <Button href="#how-it-works" variant="secondary" size="lg">
            How it works
          </Button>
        </div>
      </div>
    </section>
  );
}

/* ── Footer ──────────────────────────────────────────────────────────── */

const footerColumns: Array<{ heading: string; links: Array<{ href: string; label: string }> }> = [
  {
    heading: "Product",
    links: [
      { href: "#features", label: "Features" },
      { href: "#mastery", label: "Mastery map" },
      { href: "#integrity", label: "Integrity" },
    ],
  },
  {
    heading: "Account",
    links: [
      { href: "/signup", label: "Sign up" },
      { href: "/login", label: "Log in" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

function SiteFooter(): ReactNode {
  return (
    <footer className="border-t border-line py-14">
      <div className="layout grid gap-10 md:grid-cols-[2fr_1fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-body-md text-ink-subtle">
            The document you own is the best study source. StudyStack turns it into a
            system.
          </p>
        </div>
        {footerColumns.map((col) => (
          <nav key={col.heading} aria-label={col.heading}>
            <p className="text-label-sm uppercase text-ink-subtle">{col.heading}</p>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="text-body-md text-ink-muted transition-colors hover:text-primary"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="layout mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
        <p className="text-label-md text-ink-subtle">© 2026 StudyStack</p>
        <p className="text-label-sm text-ink-subtle">
          built for autodidacts, researchers & exam survivors
        </p>
      </div>
    </footer>
  );
}
