import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fileReferences,
  parseActionReference,
  pinViolations,
  treeReferences,
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

  it("collects every uses: value, leaving the reference filter to decide", () => {
    const source = `jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.20
      - uses: actions/checkout@v7
`;
    expect(usesValues(source)).toHaveLength(3);
    expect(fileReferences("wf.yaml", source)).toEqual([
      { file: "wf.yaml", name: "actions/checkout", ref: "v7" },
    ]);
  });
});

describe("reference parsing", () => {
  it("splits a registry pin at the last @", () => {
    expect(parseActionReference("actions/checkout@v7")).toEqual({
      name: "actions/checkout",
      ref: "v7",
    });
    expect(
      parseActionReference("octo/repo/.github/workflows/reusable.yaml@main"),
    ).toEqual({
      name: "octo/repo/.github/workflows/reusable.yaml",
      ref: "main",
    });
  });

  it("ignores local and docker references", () => {
    expect(parseActionReference("./.github/actions/setup")).toBeNull();
    expect(parseActionReference("docker://alpine:3.20")).toBeNull();
  });

  it("keeps a remote reference carrying no usable ref, as written", () => {
    for (const reference of ["actions/checkout", "actions/checkout@", "@v7"]) {
      expect(parseActionReference(reference)).toEqual({
        name: reference,
        ref: null,
      });
    }
  });
});

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
    // A leading @ is a YAML reserved indicator, so a workflow can only carry
    // that shape quoted; the parser rejects the plain form outright.
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
    expect(() => usesValues(usingStep("@v7"))).toThrow(
      /cannot start with reserved character @/,
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

      const { workflowReferences, actionReferences } = treeReferences(root);
      expect(workflowReferences.map((reference) => reference.file)).toEqual([
        ".github/workflows/a.yml",
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
        ".github/workflows/b.yaml",
      ]);
      expect(actionReferences).toEqual([
        {
          file: ".github/actions/setup/action.yml",
          name: "actions/setup-node",
          ref: "v6",
        },
      ]);
      expect(pinViolations(workflowReferences, actionReferences)).toHaveLength(
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries a ref-less workflow reference through to a violation", () => {
    const root = mkdtempSync(join(tmpdir(), "action-pin-drift-"));
    try {
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(root, ".github/workflows/a.yml"),
        `jobs:
  build:
    steps:
      - uses: actions/checkout
`,
        "utf8",
      );

      const { workflowReferences, actionReferences } = treeReferences(root);
      expect(workflowReferences).toEqual([
        {
          file: ".github/workflows/a.yml",
          name: "actions/checkout",
          ref: null,
        },
      ]);
      expect(pinViolations(workflowReferences, actionReferences)).toEqual([
        expect.stringContaining(
          "actions/checkout in .github/workflows/a.yml names no ref",
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
