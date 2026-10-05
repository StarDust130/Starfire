import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = new URL(".", import.meta.url);
const r = (p: string) => fileURLToPath(new URL(p, here));

export default defineConfig({
  root: r("."),
  server: { fs: { allow: [r("..")] } },
  test: { include: ["selftest/**/*.test.ts"] },
});
