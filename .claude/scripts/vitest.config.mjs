import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest project for the session tooling in .claude/scripts (what belongs here is
// in README.md beside it). These are plain .mjs scripts outside the workspaces,
// so they are not covered by `npm test` (which fans out to packages/* and
// apps/*); the root vitest config registers this as a project so `npx vitest`
// (and `npm run test:scripts`) discovers them. The tests are deterministic and
// offline: the board tooling is driven with synthetic GraphQL pages rather than a
// live board, and where a suite drives a real tool (git, npm) it does so
// over a fixture it builds in a temp directory. They need no network and no gh
// auth.
export default defineConfig({
  test: {
    name: "scripts",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.mjs"],
    environment: "node",
  },
});
