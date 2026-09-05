import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An application deployment and a configuration-only deployment run separate
// Elastic Beanstalk hook trees, so the certificate-download hook is deployed
// twice: apps/web/deploy/aws_eb/.platform/hooks/prebuild/download_certificates.sh
// and .../confighooks/prebuild/download_certificates.sh. Nothing but a comment
// in each file keeps them in step -- an edit landing in one silently
// reintroduces the certificate-load failure the other copy exists to fix.
// This pins both halves of that arrangement: identical bytes, and both
// executable in the index the way EB expects a hook script to be.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const HOOK_TREES = [
  "apps/web/deploy/aws_eb/.platform/hooks/prebuild/download_certificates.sh",
  "apps/web/deploy/aws_eb/.platform/confighooks/prebuild/download_certificates.sh",
];

const read = (relative) => readFileSync(resolve(repoRoot, relative), "utf8");

describe("the EB certificate download hook's two copies", () => {
  it("are byte-identical", () => {
    const [first, ...rest] = HOOK_TREES.map(read);
    for (const content of rest) {
      expect(content).toBe(first);
    }
  });

  it("both fail the hook loudly on a failed download", () => {
    // The MINOR half of the same finding: without `set -e`, the script's exit
    // status is the last chmod's, so a failed key download exits 0 and nginx
    // later fails on a missing key with a confusing signature.
    for (const content of HOOK_TREES.map(read)) {
      expect(content.split("\n").slice(0, 2)).toEqual([
        "#!/bin/bash",
        "set -euo pipefail",
      ]);
    }
  });

  it("are both executable in the git index (mode 100755)", () => {
    // Read from the index rather than the filesystem: what EB actually deploys
    // is the committed blob's mode, not whatever the working tree happens to
    // hold locally.
    const output = execFileSync("git", ["ls-files", "-s", ...HOOK_TREES], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const lines = output.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(HOOK_TREES.length);
    for (const line of lines) {
      expect(line).toMatch(/^100755 /);
    }
  });
});
