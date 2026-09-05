import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pinViolations } from "./check-action-pin-drift.mjs";
import {
  coversAction,
  githubActionsIgnoreEntries,
  isFloatingMajor,
  shapeViolations,
  suppressesWithinMajor,
} from "./check-dependabot-ignore-shape.mjs";
import { fileReferences, treeReferences } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const WITHIN_MAJOR = [
  "version-update:semver-minor",
  "version-update:semver-patch",
];

const entry = (dependencyName, updateTypes = WITHIN_MAJOR) => ({
  dependencyName,
  updateTypes,
});

const step = (reference) => `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${reference}
`;

const workflowPins = (reference) =>
  fileReferences(".github/workflows/pr.yaml", step(reference));

const config = (ignore) => `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    ignore:
      - dependency-name: "left-pad"
  - package-ecosystem: github-actions
    directory: "/"
${ignore}
`;

describe("reading the ignore list out of the config", () => {
  it("takes the github-actions block's entries, not another ecosystem's", () => {
    expect(
      githubActionsIgnoreEntries(
        config(`    ignore:
      - dependency-name: "actions/*"
        update-types:
          ["version-update:semver-minor", "version-update:semver-patch"]
      - dependency-name: "docker/*"
        update-types: ["version-update:semver-major"]
`),
      ),
    ).toEqual([
      { dependencyName: "actions/*", updateTypes: WITHIN_MAJOR },
      {
        dependencyName: "docker/*",
        updateTypes: ["version-update:semver-major"],
      },
    ]);
  });

  it("reads an entry naming no update type as a null updateTypes", () => {
    expect(
      githubActionsIgnoreEntries(
        config(`    ignore:
      - dependency-name: "actions/*"
`),
      ),
    ).toEqual([{ dependencyName: "actions/*", updateTypes: null }]);
  });

  it("reads a block with no ignore list as no entries", () => {
    expect(
      githubActionsIgnoreEntries(config(`    open-pull-requests-limit: 5`)),
    ).toEqual([]);
  });

  it("returns null when no github-actions block matched, so the CLI can fail closed", () => {
    expect(
      githubActionsIgnoreEntries(`version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
`),
    ).toBeNull();
    expect(githubActionsIgnoreEntries("version: 2\n")).toBeNull();
  });
});

describe("what an entry suppresses", () => {
  it("counts minor, patch, and an absent update-types as within-major", () => {
    expect(suppressesWithinMajor(entry("actions/*"))).toBe(true);
    expect(
      suppressesWithinMajor(
        entry("actions/*", ["version-update:semver-minor"]),
      ),
    ).toBe(true);
    expect(
      suppressesWithinMajor(
        entry("actions/*", ["version-update:semver-patch"]),
      ),
    ).toBe(true);
    expect(suppressesWithinMajor(entry("actions/*", null))).toBe(true);
  });

  it("does not count a major-only entry", () => {
    expect(
      suppressesWithinMajor(
        entry("actions/*", ["version-update:semver-major"]),
      ),
    ).toBe(false);
    expect(suppressesWithinMajor(entry("actions/*", []))).toBe(false);
  });
});

describe("dependency-name matching", () => {
  it("reads * inclusively, across a subpath separator", () => {
    expect(coversAction("github/*", "github/codeql-action/init")).toBe(true);
    expect(coversAction("actions/*", "actions/checkout")).toBe(true);
    expect(coversAction("actions/*", "actions-rs/toolchain")).toBe(false);
  });

  it("matches an exact dependency-name and treats other characters literally", () => {
    expect(coversAction("actions/checkout", "actions/checkout")).toBe(true);
    expect(coversAction("actions/checkout", "actions/checkout-v2")).toBe(false);
    expect(coversAction("actions.checkout", "actionsXcheckout")).toBe(false);
  });
});

describe("pin shape", () => {
  it("accepts a bare major and rejects everything else", () => {
    expect(isFloatingMajor("v7")).toBe(true);
    expect(isFloatingMajor("v10")).toBe(true);
    expect(isFloatingMajor("v7.0.1")).toBe(false);
    expect(isFloatingMajor("v7.0")).toBe(false);
    expect(isFloatingMajor("main")).toBe(false);
    expect(isFloatingMajor("7")).toBe(false);
  });
});

describe("a pin covered by a within-major ignore entry", () => {
  it("fails on an exact version", () => {
    const violations = shapeViolations(
      workflowPins("actions/checkout@v7.0.1"),
      [entry("actions/*")],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "actions/checkout@v7.0.1 in .github/workflows/pr.yaml is not pinned to a bare floating major tag",
    );
    expect(violations[0]).toContain('under dependency-name "actions/*"');
    expect(violations[0]).toContain("Re-pin it to the floating major tag");
    expect(violations[0]).toContain("drop or narrow the entry");
  });

  it("fails on a commit sha", () => {
    const violations = shapeViolations(
      workflowPins("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"),
      [entry("actions/*")],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    );
  });

  it("fails on a branch name", () => {
    const violations = shapeViolations(workflowPins("actions/checkout@main"), [
      entry("actions/*"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("actions/checkout@main");
  });

  it("fails on a subpath action under the inclusive glob reading", () => {
    const violations = shapeViolations(
      workflowPins("github/codeql-action/init@v4.1.2"),
      [entry("github/*")],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("github/codeql-action/init@v4.1.2");
  });

  it("passes a bare floating major", () => {
    expect(
      shapeViolations(workflowPins("actions/checkout@v7"), [
        entry("actions/*"),
      ]),
    ).toEqual([]);
  });

  it("names each file an offending pin appears in, once per file", () => {
    const violations = shapeViolations(
      [
        ...fileReferences(
          ".github/workflows/a.yaml",
          `jobs:
  build:
    steps:
      - uses: actions/checkout@v7.0.1
  publish:
    steps:
      - uses: actions/checkout@v7.0.1
`,
        ),
        ...fileReferences(
          ".github/actions/setup/action.yml",
          step("actions/checkout@v7.0.1"),
        ),
      ],
      [entry("actions/*")],
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain(".github/workflows/a.yaml");
    expect(violations[1]).toContain(".github/actions/setup/action.yml");
  });
});

describe("a pin no within-major ignore entry covers", () => {
  it("passes an exact pin from an unlisted org", () => {
    expect(
      shapeViolations(workflowPins("sigstore/cosign-installer@v4.1.2"), [
        entry("actions/*"),
        entry("docker/*"),
        entry("aws-actions/*"),
        entry("github/*"),
      ]),
    ).toEqual([]);
  });

  it("passes an exact pin under an entry whose update-types omit the within-major pair", () => {
    expect(
      shapeViolations(workflowPins("actions/checkout@v7.0.1"), [
        entry("actions/*", ["version-update:semver-major"]),
      ]),
    ).toEqual([]);
  });

  it("produces nothing for an entry naming an org absent from both trees", () => {
    expect(
      shapeViolations(workflowPins("actions/checkout@v7"), [
        entry("actions/*"),
        entry("nowhere-org/*"),
      ]),
    ).toEqual([]);
  });
});

describe("a reference naming no ref", () => {
  it("is left to the pin drift check rather than reported twice", () => {
    const references = workflowPins("actions/checkout");
    expect(references).toEqual([
      {
        file: ".github/workflows/pr.yaml",
        name: "actions/checkout",
        ref: null,
      },
    ]);
    expect(shapeViolations(references, [entry("actions/*")])).toEqual([]);
    expect(pinViolations(references, [])).toEqual([
      expect.stringContaining(
        "actions/checkout in .github/workflows/pr.yaml names no ref",
      ),
    ]);
  });
});

describe("the real repository configuration", () => {
  it("has no pin whose shape contradicts the ignore list", () => {
    const entries = githubActionsIgnoreEntries(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    );
    expect(entries).not.toBeNull();
    expect(entries.filter(suppressesWithinMajor).length).toBeGreaterThan(0);
    const { workflowReferences, actionReferences } = treeReferences(repoRoot);
    const references = [...workflowReferences, ...actionReferences];
    expect(references.length).toBeGreaterThan(0);
    expect(shapeViolations(references, entries)).toEqual([]);
  });

  it("covers real pins, so the green above is not vacuous", () => {
    const suppressing = githubActionsIgnoreEntries(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    ).filter(suppressesWithinMajor);
    const { workflowReferences, actionReferences } = treeReferences(repoRoot);
    const covered = [...workflowReferences, ...actionReferences].filter(
      ({ name }) =>
        suppressing.some(({ dependencyName }) =>
          coversAction(dependencyName, name),
        ),
    );
    expect(covered.length).toBeGreaterThan(0);
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-dependabot-ignore-shape.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Dependabot ignore shape check passed");
  });
});
