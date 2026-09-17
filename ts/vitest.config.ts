import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config — runs canonical unit tests in `../tests/unit`
 * with `@/` mapped to `./src` (mirrors `tsconfig.json` paths).
 * E2E stays in polymorpha-tests (G22); this covers library unit only.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["../tests/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // First run downloads the Xenova model (~15s cold); warm runs take ~5s.
    testTimeout: 60000,
  },
});
