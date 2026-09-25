import type { SVGProps } from "react";

/**
 * Inline stroke icon set (24×24, currentColor) — hand-picked paths so the
 * landing page ships zero icon-library weight. If the app grows past ~20
 * icons, swap to `lucide-react` with tree-shaken imports.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3v5h5" />
      <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M9 13h6M9 17h4" />
    </Svg>
  );
}

export function IconBranch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <path d="M6 7.5v9" />
      <path d="M8.5 5.6c4.5.6 7 2.9 7 6.4a6.6 6.6 0 0 1-3 5.4" />
    </Svg>
  );
}

export function IconSparkles(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5 13.7 9l4.3 1.7L13.7 12.4 12 17l-1.7-4.6L6 10.7 10.3 9 12 4.5Z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
    </Svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    </Svg>
  );
}

export function IconStore(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9.5 5.4 5A1.5 1.5 0 0 1 6.8 4h10.4a1.5 1.5 0 0 1 1.4 1L20 9.5" />
      <path d="M4 9.5a2.4 2.4 0 0 0 4 1.8 2.4 2.4 0 0 0 4 0 2.4 2.4 0 0 0 4 0 2.4 2.4 0 0 0 4-1.8" />
      <path d="M5.5 13v6a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V13" />
    </Svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 5.8v5.4c0 4.2 2.9 7.3 7 9.3 4.1-2 7-5.1 7-9.3V5.8L12 3Z" />
      <path d="M9.2 12l2 2 3.6-4" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5l5 5L19.5 7" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </Svg>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3.5 12.5 8.5 4.7 8.5-4.7" />
      <path d="m3.5 16.8 8.5 4.7 8.5-4.7" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function IconLightbulb(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 17.5h6" />
      <path d="M10 20.5h4" />
      <path d="M12 3a6.5 6.5 0 0 0-3.9 11.7c.6.5.9 1.1.9 1.8h6c0-.7.3-1.3.9-1.8A6.5 6.5 0 0 0 12 3Z" />
    </Svg>
  );
}
