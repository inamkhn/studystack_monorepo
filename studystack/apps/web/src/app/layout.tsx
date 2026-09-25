import type { Metadata } from "next";
import {
  Inter,
  JetBrains_Mono,
  Plus_Jakarta_Sans,
} from "next/font/google";
import "./globals.css";

/**
 * Font roles — apps/web/design.md §Typography
 *  - Plus Jakarta Sans → display & headlines  (--font-jakarta)
 *  - Inter             → body & narrative     (--font-inter)
 *  - JetBrains Mono    → metadata & telemetry (--font-jb-mono)
 * `next/font` self-hosts at build time; no layout shift, no external requests.
 */
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

const jbMono = JetBrains_Mono({
  variable: "--font-jb-mono",
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "StudyStack — Your documents, turned into mastery",
    template: "%s · StudyStack",
  },
  description:
    "Upload a textbook, lecture notes or past papers and StudyStack builds a structured course around them: adaptive tutorials, quizzes, flashcards and a mastery map — all grounded in your material.",
  openGraph: {
    type: "website",
    siteName: "StudyStack",
    title: "StudyStack — Your documents, turned into mastery",
    description:
      "Turn real study material into structured, adaptive courses. Grounded in your documents, tracked to mastery.",
  },
  twitter: {
    card: "summary_large_image",
    title: "StudyStack — Your documents, turned into mastery",
    description:
      "Turn real study material into structured, adaptive courses.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${inter.variable} ${jbMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        {children}
      </body>
    </html>
  );
}
