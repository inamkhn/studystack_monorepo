// ── Language detection (F1 §2.3) ───────────────────────────────────────
// Zero-dependency heuristic so generated content can stay in the source's
// language by default. Two layers:
//   1. Non-Latin scripts are identified by Unicode ranges (zh, ja, ko, ru,
//      ar, hi, el, he, th) — a strong signal that needs no word lists.
//   2. Latin text is scored against small distinctive-stopword lists for
//      en / es / fr / de / pt / it.
// Returns a BCP-47-style code, or null when the sample is too short or no
// language wins clearly — callers must treat null as "unknown", never as
// English. Full-accuracy detection on extracted PDF/DOCX text lands with
// the AiModule ingestion pipeline; this covers plain-text uploads today.

/** Non-Latin script detection: [range regex, language code]. Checked in order. */
const SCRIPT_CODES: Array<[RegExp, string]> = [
  [/[\u3040-\u309f\u30a0-\u30ff]/, "ja"], // kana wins over CJK → Japanese
  [/[\uac00-\ud7af\u1100-\u11ff]/, "ko"], // hangul
  [/[\u4e00-\u9fff\u3400-\u4dbf]/, "zh"], // CJK ideographs
  [/[\u0400-\u04ff]/, "ru"], // cyrillic
  [/[\u0600-\u06ff]/, "ar"], // arabic
  [/[\u0900-\u097f]/, "hi"], // devanagari
  [/[\u0370-\u03ff]/, "el"], // greek
  [/[\u0590-\u05ff]/, "he"], // hebrew
  [/[\u0e00-\u0e7f]/, "th"], // thai
];

/** Distinctive stopwords per Latin-script language (kept small on purpose). */
const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "is", "are", "with", "this", "that", "have", "for"],
  es: ["los", "las", "que", "una", "para", "con", "del", "por", "como", "sus"],
  fr: ["les", "des", "est", "une", "pour", "avec", "dans", "qui", "sur", "pas"],
  de: ["der", "die", "das", "und", "ist", "ein", "eine", "mit", "nicht", "von"],
  pt: ["os", "as", "que", "um", "uma", "para", "com", "não", "são", "mais"],
  it: ["il", "di", "che", "una", "per", "sono", "con", "gli", "della", "anche"],
};

/** Words shorter than this aren't useful stopword evidence. */
const MIN_SAMPLE_WORDS = 8;

/**
 * Detects the dominant language of a text sample.
 * Returns null when undetermined (too short, or no clear winner).
 */
export function detectLanguage(text: string): string | null {
  if (!text || text.trim().length < 8) return null;

  // Layer 1: non-Latin scripts. If one accounts for ≥ 30% of all letter
  // characters, that's the language family — no word lists needed. Note the
  // minimum here is in letters, not characters: CJK text is dense, so a
  // char-count floor would wrongly reject short but fully valid samples.
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length >= 10) {
    for (const [range, code] of SCRIPT_CODES) {
      const count = letters.filter((ch) => range.test(ch)).length;
      if (count / letters.length >= 0.3) return code;
    }
  }

  // Layer 2: Latin-script stopword scoring.
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length > 0);
  if (words.length < MIN_SAMPLE_WORDS) return null;

  const wordSet = new Set(words);
  let bestCode: string | null = null;
  let bestScore = 0;
  let ties = false;

  for (const [code, list] of Object.entries(STOPWORDS)) {
    const score = list.filter((w) => wordSet.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCode = code;
      ties = false;
    } else if (score === bestScore && score > 0) {
      ties = true;
    }
  }

  // Require at least two stopword hits and an outright winner — anything
  // weaker is a guess, and a wrong guess poisons every generation prompt.
  if (bestScore < 2 || ties) return null;
  return bestCode;
}
