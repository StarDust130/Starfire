import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Precedence: already-set process env > repo-root .env > apps/desktop/.env. One key, two fallbacks. */
export function loadDotEnv(repoRoot: string = process.cwd()): void {
  for (const f of [
    join(repoRoot, ".env"),
    join(repoRoot, "apps", "desktop", ".env"),
  ]) {
    for (const [k, v] of Object.entries(parseFile(f))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
