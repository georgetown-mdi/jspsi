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
    // Every test here runs its hook as a real process, and the ones that settle
    // a question about git's behavior by driving git build a throwaway repo and
    // a linked worktree per row -- around a hundred subprocesses in the heaviest
    // case. What that costs is set by how contended the machine is rather than
    // by anything the test asserts, so the default 5s leaves the slowest of them
    // (2.3s alone, 3.1s alongside the rest of the suite) inside a margin the
    // next parallel build closes. Long enough that a real hang is still caught
    // well inside the file's own runtime.
    testTimeout: 30_000,
  },
});
