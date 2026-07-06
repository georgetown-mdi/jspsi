import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest project for the repo-root dev scripts (scripts/*.mjs -- the doc-link and
// CONTRIBUTING-scope checks). Like .claude/scripts, these live outside the
// workspaces, so `npm test` (which fans out to packages/* and apps/*) does not
// cover them; the root vitest config registers this project so `npx vitest` and
// `npm run test:scripts` discover their deterministic tests.
export default defineConfig({
  test: {
    name: "repo-scripts",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.mjs"],
    environment: "node",
  },
});
