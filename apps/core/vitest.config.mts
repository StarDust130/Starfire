import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/*
 * Internal workspace packages are aliased to their SOURCE files, so
 * tests never depend on the build state of dist/. (A stale
 * tsconfig.tsbuildinfo once made tsc -b skip emission and broke
 * runtime imports while typecheck still passed — this removes that
 * failure class entirely.)
 */
const contractsSrc = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
);

const toolsSrc = fileURLToPath(
  new URL("../../packages/tools/src/index.ts", import.meta.url),
);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],

    exclude: ["**/node_modules/**", "**/dist/**"],
  },

  resolve: {
    alias: [
      { find: /^@starfire\/tools$/, replacement: toolsSrc },

      { find: /^@starfire\/contracts$/, replacement: contractsSrc },
    ],
  },
});
