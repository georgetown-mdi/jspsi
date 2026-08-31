// The `.mts` extension is load-bearing. The repository root carries no
// `"type": "module"` (each workspace declares its own), so a `.ts` config
// here resolves as CommonJS. Vite's `configLoader: 'native'`, announced as a
// future default, hands the config to Node's own loader, which rejects ESM
// syntax in a file it resolves that way; the explicit ESM extension keeps
// every root-started vitest invocation (`npx vitest`, `npm run test:scripts`)
// loading under either loader.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reporters belong to the config that STARTS a run: a workspace config
    // reached through `projects` below contributes its projects and its
    // globalSetup, but its `reporters` are dropped. So the skipped-leg reporter
    // is registered here as well, for the runs that start at the root (`npx
    // vitest`, `npm run test:scripts`) rather than in a workspace.
    reporters: ["default", "./scripts/lib/skippedLegReporter.mjs"],
    // .claude, .claude/scripts and .claude/hooks hold the statusline, the board
    // tooling and the session hooks -- plain .mjs scripts outside the workspaces,
    // each with its own vitest config. They are not in `npm test` (which fans out
    // to the workspaces); registering the projects here lets `npx vitest` and
    // `npm run test:scripts` pick up their deterministic tests.
    projects: [
      "packages/*",
      "apps/*",
      ".claude",
      ".claude/scripts",
      ".claude/hooks",
      "scripts",
    ],
  },
});
