/*
 * Secrets redaction — runs BEFORE any conversation text leaves the
 * machine. Credential-shaped strings become typed placeholders.
 *
 * HONEST LIMITATION: pattern filters cannot catch everything (a
 * password written as ordinary words may slip through). This reduces
 * risk; it does not eliminate it. Model output referencing
 * [REDACTED:...] placeholders must never be stored as a "fact".
 */

export type RedactionResult = {
  text: string;
  redactions: string[];
};

type Rule = { name: string; source: string; flags: string };

const RULES: readonly Rule[] = [
  {
    name: "private-key",
    source:
      "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
    flags: "g",
  },
  {
    name: "jwt",
    source: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}",
    flags: "g",
  },
  {
    name: "api-key-shape",
    source:
      "\\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})",
    flags: "g",
  },
  {
    name: "assignment",
    source:
      "\\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\\b\\s*[:=]\\s*(?:\"[^\"]{4,}\"|'[^']{4,}'|\\S{4,})",
    flags: "gi",
  },
  {
    name: "spoken",
    source:
      "\\b(?:my |the |mera |meri )?(?:password|passcode|pass ?phrase|one[- ]time (?:code|password)|otp|api key|access token)\\b(?:\\s+(?:is|was|hai|hoga|ho\\s?gaya))?\\s*[:=]?\\s*([^\\s,.!?;]{4,})",
    flags: "gi",
  },
  {
    name: "bearer",
    source: "\\b(?:bearer|authorization)\\s*[:=]?\\s*[A-Za-z0-9._~+/=-]{12,}",
    flags: "gi",
  },
  {
    name: "hex-secret",
    source: "\\b[a-f0-9]{32,64}\\b",
    flags: "gi",
  },
  {
    name: "base64-secret",
    source: "\\b[A-Za-z0-9_-]{43,}\\b",
    flags: "g",
  },
];

export function redactSecrets(text: string): RedactionResult {
  let redacted = text;

  const applied: string[] = [];

  for (const rule of RULES) {
    // Fresh RegExp per call: global patterns must never share state.
    const pattern = new RegExp(rule.source, rule.flags);

    let found = false;

    redacted = redacted.replace(pattern, () => {
      found = true;

      return `[REDACTED:${rule.name}]`;
    });

    if (found) {
      applied.push(rule.name);
    }
  }

  return { text: redacted, redactions: applied };
}

export function redactTurns<T extends { content: string }>(
  turns: readonly T[],
): { turns: T[]; redactions: string[] } {
  const names = new Set<string>();

  const mapped = turns.map((turn) => {
    const result = redactSecrets(turn.content);

    for (const name of result.redactions) {
      names.add(name);
    }

    return { ...turn, content: result.text };
  });

  return { turns: mapped, redactions: [...names] };
}
