import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest project for the .claude/scripts board tooling. These are plain .mjs dev
// scripts outside the workspaces, so they are not covered by `npm test` (which
// fans out to packages/* and apps/*); the root vitest config registers this as a
// project so `npx vitest` (and `npm run test:scripts`) discovers them. The tests
// are deterministic -- they drive the GraphQL layer with synthetic pages and
// never touch a live board -- so they need no network or gh auth.
export default defineConfig({
  test: {
    name: "scripts",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.mjs"],
    environment: "node",
  },
});
