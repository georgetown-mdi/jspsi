import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest project for the .claude/hooks tooling. These are plain .mjs hook scripts
// outside the workspaces, so they are not covered by `npm test` (which fans out to
// packages/* and apps/*); the root vitest config registers this project so
// `npx vitest` and `npm run test:scripts` discover their tests.
export default defineConfig({
  test: {
    name: "hooks",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.mjs"],
    environment: "node",
  },
});
