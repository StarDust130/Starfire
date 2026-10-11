import type { MemoryCategory } from "./memories.js";

/*
 * Instant local capture for EXPLICIT statements.
 *
 * Cloud extraction (GLM) runs after the session ends and can be
 * deferred by rate limits — a fact stated seconds before the app
 * closes could be lost. Explicit statements deserve better: they are
 * recognized locally by narrow patterns and stored IMMEDIATELY.
 *
 * Design rules:
 * - Narrow patterns only: wrong guesses are worse than no fast path.
 * - Negations never match ("my name is not X" stores nothing).
 * - Multi-word names only when continuation words are Capitalized
 *   (proper-noun signal) — conservative by design.
 * - NO global /i flag: it would silently make the Capitalized
 *   continuation rule case-insensitive too ("john smith" would save
 *   "John Smith"). Trigger words handle their own case tolerance.
 * - Questions never match ("do you remember my name?" stores nothing).
 * - Secret-shaped statements are refused by the caller (redaction).
 * - GLM still runs later on the same turns; the stable key means its
 *   phrasing confirms or supersedes the fast-path row cleanly.
 */

export type ExplicitFact = {
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
};

/*
 * Trigger words tolerate any case via character classes; the capture
 * group stays case-strict: continuation words MUST start [A-Z].
 */
const NAME_PATTERN =
  /\b(?:[Mm]y [Nn]ame [Ii]s|[Cc]all [Mm]e|[Ii] [Aa][Mm] [Cc]alled|[Ii]'?[Mm] [Cc]alled|[Mm]era [Nn]aam(?: [Hh]ai)?)\s+([A-Za-z][A-Za-z'-]{0,30}(?:\s+[A-Z][A-Za-z'-]{0,30}){0,2})\b/;

/*
 * Words that turn "my name is ___" into a negation or uncertainty —
 * a correction like "my name is not Thor" must NEVER store "Not".
 */
const NAME_NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "nah",
  "nahi",
  "unknown",
  "nothing",
  "none",
  "unsure",
  "maybe",
  "later",
  "skip",
  "dont",
  "idk",
]);

const COLOR_PATTERN =
  /\bmy favorite (?:color|colour) is\s+([A-Za-z]+(?: [A-Za-z]+){0,2})\b/i;

const REMEMBER_PATTERN = /\bremember (?:that|this)\s+(.{4,140}?)[.!?\s]*$/i;

function displayCase(word: string): string {
  // Preserve spellings like "McAllister"; fix "thor" -> "Thor".
  return /^[A-Z]/.test(word)
    ? word
    : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function detectExplicitFact(text: string): ExplicitFact | null {
  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > 200) {
    return null;
  }

  const name = NAME_PATTERN.exec(trimmed);

  if (name?.[1]) {
    const words = name[1].trim().split(/\s+/);

    if (NAME_NEGATIONS.has(words[0]?.toLowerCase() ?? "")) {
      return null;
    }

    return {
      category: "profile",
      key: "user.name",
      content: `The user's name is ${words.map(displayCase).join(" ")}.`,
      importance: 5,
    };
  }

  const color = COLOR_PATTERN.exec(trimmed);

  if (color?.[1]) {
    return {
      category: "preference",
      key: "favorite-color",
      content: `The user's favorite color is ${color[1].toLowerCase()}.`,
      importance: 4,
    };
  }

  const remember = REMEMBER_PATTERN.exec(trimmed);

  if (remember?.[1]) {
    const fact = remember[1].trim();

    const slug = fact
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    if (slug.length === 0) {
      return null;
    }

    return {
      category: "fact",
      key: `note.${slug}`,
      content: `The user asked to remember: ${fact}.`,
      importance: 4,
    };
  }

  return null;
}
