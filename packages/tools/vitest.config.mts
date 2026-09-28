import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const contractsSrc = fileURLToPath(
  new URL("../contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],

    exclude: ["**/node_modules/**", "**/dist/**"],
  },

  resolve: {
    alias: [{ find: /^@starfire\/contracts$/, replacement: contractsSrc }],
  },
});
