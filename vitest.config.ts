import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
