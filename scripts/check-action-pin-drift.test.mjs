import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  filePins,
  parseActionPin,
  pinViolations,
  treePins,
  usesValues,
} from "./check-action-pin-drift.mjs";

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

describe("uses: walk", () => {
  it("finds a step's uses, a job-level reusable-workflow uses, and a composite's", () => {
    const source = `jobs:
  call:
    uses: octo/repo/.github/workflows/reusable.yaml@v3
  build:
    steps:
      - uses: actions/checkout@v7
runs:
  using: "composite"
  steps:
    - uses: actions/setup-node@v7
`;
    expect(usesValues(source)).toEqual([
      "octo/repo/.github/workflows/reusable.yaml@v3",
      "actions/checkout@v7",
      "actions/setup-node@v7",
    ]);
  });

  it("collects every uses: value, leaving the pin filter to decide", () => {
    const source = `jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.20
      - uses: actions/checkout@v7
`;
    expect(usesValues(source)).toHaveLength(3);
    expect(filePins("wf.yaml", source)).toEqual([
      { file: "wf.yaml", name: "actions/checkout", ref: "v7" },
    ]);
  });
});

describe("pin parsing", () => {
  it("splits a registry pin at the last @", () => {
    expect(parseActionPin("actions/checkout@v7")).toEqual({
      name: "actions/checkout",
      ref: "v7",
    });
    expect(
      parseActionPin("octo/repo/.github/workflows/reusable.yaml@main"),
    ).toEqual({
      name: "octo/repo/.github/workflows/reusable.yaml",
      ref: "main",
    });
  });

  it("ignores local and docker references", () => {
    expect(parseActionPin("./.github/actions/setup")).toBeNull();
    expect(parseActionPin("docker://alpine:3.20")).toBeNull();
  });

  it("ignores a reference carrying no usable ref", () => {
    for (const reference of ["actions/checkout", "actions/checkout@", "@v7"]) {
      expect(parseActionPin(reference)).toBeNull();
    }
  });
});

describe("rule A: composite and workflow refs must agree", () => {
  it("passes when both trees pin the same ref", () => {
    expect(
      pinViolations(
        filePins(".github/workflows/pr.yaml", workflow("v7")),
        filePins(".github/actions/setup/action.yml", composite("v7")),
      ),
    ).toEqual([]);
  });

  it("fails when a bump lands on the workflow and not the composite", () => {
    const violations = pinViolations(
      filePins(".github/workflows/pr.yaml", workflow("v7")),
      filePins(".github/actions/setup/action.yml", composite("v6")),
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
        ...filePins(".github/workflows/bumped.yaml", workflow("v7")),
        ...filePins(".github/workflows/stale.yaml", workflow("v6")),
      ],
      filePins(".github/actions/setup/action.yml", composite("v7")),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(".github/workflows/stale.yaml");
  });
});

describe("rule B: a composite pin needs a workflow counterpart", () => {
  it("fails on an action no workflow uses", () => {
    const violations = pinViolations(
      filePins(".github/workflows/pr.yaml", workflow("v7")),
      filePins(
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

describe("tree discovery", () => {
  it("reads .yml and .yaml workflows and only action.yml/action.yaml composites", () => {
    const root = mkdtempSync(join(tmpdir(), "action-pin-drift-"));
    try {
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      mkdirSync(join(root, ".github/actions/setup"), { recursive: true });
      writeFileSync(
        join(root, ".github/workflows/a.yml"),
        workflow("v7"),
        "utf8",
      );
      writeFileSync(
        join(root, ".github/workflows/b.yaml"),
        workflow("v7"),
        "utf8",
      );
      writeFileSync(join(root, ".github/workflows/README.md"), "not yaml\n");
      writeFileSync(
        join(root, ".github/actions/setup/action.yml"),
        composite("v6"),
        "utf8",
      );
      writeFileSync(
        join(root, ".github/actions/setup/notes.yml"),
        composite("v5"),
        "utf8",
      );

      const { workflowPins, actionPins } = treePins(root);
      expect(workflowPins.map((pin) => pin.file)).toEqual([
        ".github/workflows/a.yml",
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
        ".github/workflows/b.yaml",
      ]);
      expect(actionPins).toEqual([
        {
          file: ".github/actions/setup/action.yml",
          name: "actions/setup-node",
          ref: "v6",
        },
      ]);
      expect(pinViolations(workflowPins, actionPins)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the real repository tree", () => {
  it("has no action pin drift", () => {
    const { workflowPins, actionPins } = treePins(repoRoot);
    expect(workflowPins.length).toBeGreaterThan(0);
    expect(actionPins.length).toBeGreaterThan(0);
    expect(pinViolations(workflowPins, actionPins)).toEqual([]);
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
