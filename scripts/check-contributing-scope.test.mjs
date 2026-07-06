import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_HEADINGS,
  scopeViolations,
} from "./check-contributing-scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// A minimal document that contains every allowlisted heading, so a test can add
// one offending line and read the violation without the dead-entry check firing.
const fullDoc =
  "# Contributing\n\n" +
  ALLOWED_HEADINGS.map((h) => `## ${h}\n\nbody\n`).join("\n");

describe("CONTRIBUTING scope guard", () => {
  it("passes on the real CONTRIBUTING.md", () => {
    const text = readFileSync(resolve(here, "..", "CONTRIBUTING.md"), "utf8");
    expect(scopeViolations(text)).toEqual([]);
  });

  it("flags a reintroduced section not on the allowlist", () => {
    const text = fullDoc + "\n## Upgrading the SFTP Stack\n\nssh2 internals\n";
    const v = scopeViolations(text);
    expect(
      v.some((m) =>
        m.includes('unexpected section "Upgrading the SFTP Stack"'),
      ),
    ).toBe(true);
  });

  it("flags a dependency source-path citation in prose", () => {
    const text =
      fullDoc + "\nSee `node_modules/ssh2/lib/client.js` for the seam.\n";
    const v = scopeViolations(text);
    expect(v.some((m) => m.includes("dependency source-path citation"))).toBe(
      true,
    );
  });

  it("does not flag a single-package reinstall path", () => {
    const text = fullDoc + "\nRun `rm -rf node_modules/ssh2` then reinstall.\n";
    const sourceHits = scopeViolations(text).filter((m) =>
      m.includes("dependency source-path citation"),
    );
    expect(sourceHits).toEqual([]);
  });

  it("does not flag node_modules inside a fenced code block", () => {
    const text = fullDoc + "\n```sh\nls node_modules/ssh2/lib\n```\n";
    const sourceHits = scopeViolations(text).filter((m) =>
      m.includes("dependency source-path citation"),
    );
    expect(sourceHits).toEqual([]);
  });

  it("flags an allowlist entry that no longer appears (cannot rot)", () => {
    const text = "# Contributing\n\n## Prerequisites\n\nbody\n";
    const v = scopeViolations(text);
    expect(v.some((m) => m.includes("no longer appears"))).toBe(true);
  });
});
