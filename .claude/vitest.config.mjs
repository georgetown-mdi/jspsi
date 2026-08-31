import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vitest project for the executables at the .claude root -- the statusline the
// harness renders each session. Like the board tooling in .claude/scripts and the
// hooks in .claude/hooks, they are plain .mjs files outside the workspaces, so
// `npm test` (which fans out to packages/* and apps/*) does not cover them; the
// root vitest config registers this project so `npx vitest` and `npm run
// test:scripts` discover their tests. The include pattern does not recurse: those
// two directories are projects of their own, each owning the tests beside it.
export default defineConfig({
  test: {
    name: "harness",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["*.test.mjs"],
    environment: "node",
  },
});
