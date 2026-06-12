import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .claude/scripts holds the board tooling -- plain .mjs scripts outside the
    // workspaces, with their own vitest config. They are not in `npm test`
    // (which fans out to the workspaces); registering the project here lets
    // `npx vitest` and `npm run test:scripts` pick up their deterministic tests.
    projects: ["packages/*", "apps/*", ".claude/scripts"],
  },
});
