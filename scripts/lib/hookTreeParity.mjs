import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// An application deployment and a configuration-only deployment run separate
// Elastic Beanstalk hook trees, so a hook that has to run on both is deployed
// twice, once under .platform/hooks and once under .platform/confighooks.
// Nothing but a comment in each copy keeps them in step -- an edit landing in
// one leaves the other running the behavior the pair exists to end -- and what
// EB deploys is the committed blob's mode, not the working tree's. Every such
// pair registers here so a new one is held to the same three.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const read = (relative) => readFileSync(resolve(REPO_ROOT, relative), "utf8");

/**
 * Registers the checks that hold one hook's deployed copies in step.
 *
 * @param {string} description - names the hook, as the describe block's subject.
 * @param {string[]} hookTrees - the copies' paths, relative to the repository root.
 */
export const describeHookTreeParity = (description, hookTrees) => {
  describe(description, () => {
    it("are byte-identical", () => {
      const [first, ...rest] = hookTrees.map(read);
      for (const content of rest) {
        expect(content).toBe(first);
      }
    });

    it("all stop on the first failed command", () => {
      // Without `set -e` a hook's exit status is its last command's, so a
      // failed step exits 0 and the deployment carries on past it.
      for (const content of hookTrees.map(read)) {
        expect(content.split("\n").slice(0, 2)).toEqual([
          "#!/bin/bash",
          "set -euo pipefail",
        ]);
      }
    });

    it("are all executable in the git index (mode 100755)", () => {
      const output = execFileSync("git", ["ls-files", "-s", ...hookTrees], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      const lines = output.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(hookTrees.length);
      for (const line of lines) {
        expect(line).toMatch(/^100755 /);
      }
    });
  });
};
