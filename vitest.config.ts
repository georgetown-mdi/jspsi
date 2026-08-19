import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reporters belong to the config that STARTS a run: a workspace config
    // reached through `projects` below contributes its projects and its
    // globalSetup, but its `reporters` are dropped. So the skipped-leg reporter
    // is registered here as well, for the runs that start at the root (`npx
    // vitest`, `npm run test:scripts`) rather than in a workspace.
    reporters: ["default", "./scripts/lib/skippedLegReporter.mjs"],
    // .claude/scripts and .claude/hooks hold the board tooling and the session
    // hooks -- plain .mjs scripts outside the workspaces, each with its own vitest
    // config. They are not in `npm test` (which fans out to the workspaces);
    // registering the projects here lets `npx vitest` and `npm run test:scripts`
    // pick up their deterministic tests.
    projects: [
      "packages/*",
      "apps/*",
      ".claude/scripts",
      ".claude/hooks",
      "scripts",
    ],
  },
});
