import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pinViolations } from "./check-action-pin-drift.mjs";
import { fileReferences, treeReferences } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const workflow = (ref) => `name: Build
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: ./.github/actions/setup
      - name: Setup Node
        uses: actions/setup-node@${ref}
`;

const composite = (ref) => `name: "Setup"
description: "Set up Node"
runs:
  using: "composite"
  steps:
    - name: Setup Node
      uses: actions/setup-node@${ref}
    - name: Install
      run: npm ci
      shell: bash
`;

describe("rule A: composite and workflow refs must agree", () => {
  it("passes when both trees pin the same ref", () => {
    expect(
      pinViolations(
        fileReferences(".github/workflows/pr.yaml", workflow("v7")),
        fileReferences(".github/actions/setup/action.yml", composite("v7")),
      ),
    ).toEqual([]);
  });

  it("fails when a bump lands on the workflow and not the composite", () => {
    const violations = pinViolations(
      fileReferences(".github/workflows/pr.yaml", workflow("v7")),
      fileReferences(".github/actions/setup/action.yml", composite("v6")),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "actions/setup-node is pinned at differing",
    );
    expect(violations[0]).toContain("@v7 (.github/workflows/pr.yaml)");
    expect(violations[0]).toContain("@v6 (.github/actions/setup/action.yml)");
  });

  it("fails when a bump lands on only some of the workflows", () => {
    const violations = pinViolations(
      [
        ...fileReferences(".github/workflows/bumped.yaml", workflow("v7")),
        ...fileReferences(".github/workflows/stale.yaml", workflow("v6")),
      ],
      fileReferences(".github/actions/setup/action.yml", composite("v7")),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(".github/workflows/stale.yaml");
  });
});

describe("rule B: a composite pin needs a workflow counterpart", () => {
  it("fails on an action no workflow uses", () => {
    const violations = pinViolations(
      fileReferences(".github/workflows/pr.yaml", workflow("v7")),
      fileReferences(
        ".github/actions/setup/action.yml",
        `runs:
  using: "composite"
  steps:
    - uses: octo/cache-warmer@v2
`,
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "octo/cache-warmer is pinned only under .github/actions",
    );
    expect(violations[0]).toContain("@v2 (.github/actions/setup/action.yml)");
    expect(violations[0]).toContain("Mirror it into a workflow");
  });
});

describe("rule C: every remote reference names a ref", () => {
  const usingStep = (reference) => `jobs:
  build:
    steps:
      - uses: ${reference}
`;

  it("fails on a ref-less reference under .github/workflows", () => {
    const violations = pinViolations(
      [
        ...fileReferences(".github/workflows/pr.yaml", workflow("v7")),
        ...fileReferences(
          ".github/workflows/unpinned.yaml",
          usingStep("actions/setup-node"),
        ),
      ],
      fileReferences(".github/actions/setup/action.yml", composite("v7")),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "actions/setup-node in .github/workflows/unpinned.yaml names no ref",
    );
    expect(violations[0]).toContain("Write it as owner/action@ref");
  });

  it("fails on a ref-less reference under .github/actions", () => {
    const violations = pinViolations(
      fileReferences(".github/workflows/pr.yaml", workflow("v7")),
      fileReferences(
        ".github/actions/setup/action.yml",
        usingStep("actions/setup-node"),
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "actions/setup-node in .github/actions/setup/action.yml names no ref",
    );
  });

  it("fails on a trailing @ and on a leading @, echoing the reference", () => {
    const violations = pinViolations(
      [
        ...fileReferences(
          ".github/workflows/trailing.yaml",
          usingStep("actions/setup-node@"),
        ),
        ...fileReferences(".github/workflows/leading.yaml", usingStep('"@v7"')),
      ],
      [],
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain(
      "actions/setup-node@ in .github/workflows/trailing.yaml names no ref",
    );
    expect(violations[1]).toContain(
      "@v7 in .github/workflows/leading.yaml names no ref",
    );
  });

  it("passes local, docker, and fully pinned references", () => {
    expect(
      pinViolations(
        [
          ...fileReferences(".github/workflows/pr.yaml", workflow("v7")),
          ...fileReferences(
            ".github/workflows/other.yaml",
            usingStep("docker://alpine:3.20"),
          ),
        ],
        fileReferences(".github/actions/setup/action.yml", composite("v7")),
      ),
    ).toEqual([]);
  });

  it("does not let a ref-less reference stand in for a mirrored pin", () => {
    const violations = pinViolations(
      fileReferences(
        ".github/workflows/pr.yaml",
        usingStep("actions/setup-node"),
      ),
      fileReferences(".github/actions/setup/action.yml", composite("v7")),
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("names no ref");
    expect(violations[1]).toContain(
      "actions/setup-node is pinned only under .github/actions",
    );
  });
});

describe("the real repository tree", () => {
  it("has no action pin drift", () => {
    const { workflowReferences, actionReferences } = treeReferences(repoRoot);
    expect(workflowReferences.length).toBeGreaterThan(0);
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(pinViolations(workflowReferences, actionReferences)).toEqual([]);
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-action-pin-drift.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Action pin drift check passed");
  });
});
