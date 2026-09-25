import { Badge } from "@/components/ui/badge";

/**
 * Hero product mock — pure markup (no images, no client JS) styled to read as
 * the course-structure surface: Level-2 glass frame, mono metadata header,
 * module tree + mastery telemetry.
 */

const modules = [
  {
    title: "Bonding & Structure",
    progress: 92,
    subtopics: ["Lewis structures", "VSEPR geometry", "Hybridisation"],
  },
  {
    title: "Reaction Mechanisms",
    progress: 64,
    subtopics: ["Nucleophilic substitution", "Elimination pathways"],
  },
  {
    title: "Spectroscopy",
    progress: 28,
    subtopics: ["IR absorption bands", "¹H NMR splitting"],
  },
];

export function CourseStructureMock() {
  return (
    <div className="glass-2 rounded-frame node-glow p-1.5">
      {/* mono metadata bar */}
      <div className="flex items-center justify-between gap-3 rounded-[calc(var(--radius-frame)-0.375rem)] bg-canvas/60 px-4 py-3">
        <span className="truncate text-label-md text-ink-subtle">
          organic-chemistry · midterm
        </span>
        <Badge dotColor="bg-mastery" className="border-mastery/30 bg-mastery/8">
          ready
        </Badge>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-5">
        {/* module tree */}
        <div className="space-y-4 sm:col-span-3">
          <p className="text-label-sm uppercase text-ink-subtle">course structure</p>
          {modules.map((m) => (
            <div
              key={m.title}
              className="rounded-card border border-line bg-surface/60 p-3.5"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-body-md font-medium text-ink">{m.title}</p>
                <span className="text-label-md text-telemetry">{m.progress}%</span>
              </div>
              <div className="track mt-2.5 h-1 overflow-hidden rounded-full">
                <div className="mastery-fill h-full rounded-full" style={{ width: `${m.progress}%` }} />
              </div>
              <ul className="mt-2.5 flex flex-wrap gap-1.5">
                {m.subtopics.map((s) => (
                  <li
                    key={s}
                    className="rounded-full border border-line px-2 py-0.5 text-label-sm text-ink-subtle"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* adaptive tutorial panel */}
        <div className="flex flex-col gap-3 sm:col-span-2">
          <p className="text-label-sm uppercase text-ink-subtle">adaptive tutorial</p>
          <div className="rounded-card border border-primary/25 bg-primary/8 p-3.5">
            <p className="text-label-sm uppercase text-ink-subtle">explanation level</p>
            <div className="mt-2 flex gap-1.5" aria-hidden>
              <span className="rounded-component bg-primary px-2.5 py-1 text-label-md text-on-primary">
                exam-ready
              </span>
              <span className="rounded-component border border-line px-2.5 py-1 text-label-md text-ink-subtle">
                first-pass
              </span>
            </div>
          </div>
          <div className="rounded-card border border-line bg-canvas/60 p-3.5">
            <p className="text-body-sm leading-relaxed text-ink-muted">
              S&#7505; attacks the carbon and pushes the C–Cl bond off as chloride…
            </p>
            <p className="mt-3 text-label-sm text-ink-subtle">
              grounded in your notes · p. 214
            </p>
          </div>
          <div className="mt-auto flex items-center gap-2">
            <kbd className="kbd">1</kbd>
            <kbd className="kbd">2</kbd>
            <kbd className="kbd">3</kbd>
            <span className="text-label-sm text-ink-subtle">recall answer</span>
          </div>
        </div>
      </div>
    </div>
  );
}
