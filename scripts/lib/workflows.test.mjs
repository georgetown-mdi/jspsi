import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  compositeFiles,
  fileReferences,
  parseActionReference,
  parseWorkflow,
  readWorkflows,
  treeReferences,
  workflowDocument,
  workflowFiles,
} from "./workflows.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

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

/** Runs `body` against a temporary tree, removed afterwards. */
function withTree(body) {
  const root = mkdtempSync(join(tmpdir(), "workflows-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const write = (root, path, contents) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents, "utf8");
};

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
    expect(fileReferences("wf.yaml", source)).toEqual([
      {
        file: "wf.yaml",
        name: "octo/repo/.github/workflows/reusable.yaml",
        ref: "v3",
      },
      { file: "wf.yaml", name: "actions/checkout", ref: "v7" },
      { file: "wf.yaml", name: "actions/setup-node", ref: "v7" },
    ]);
  });

  it("leaves out the local and docker references the filter names no action for", () => {
    const source = `jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
      - uses: docker://alpine:3.20
      - uses: actions/checkout@v7
`;
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

  it("keeps a remote reference with no usable ref, as written", () => {
    for (const reference of ["actions/checkout", "actions/checkout@", "@v7"]) {
      expect(parseActionReference(reference)).toEqual({
        name: reference,
        ref: null,
      });
    }
  });
});

describe("the parse", () => {
  it("names the file it could not read", () => {
    expect(() =>
      parseWorkflow(
        ".github/workflows/broken.yaml",
        "jobs:\n  - [unbalanced\n",
      ),
    ).toThrow(/\.github\/workflows\/broken\.yaml: could not be parsed as YAML/);
    expect(() =>
      fileReferences(
        ".github/workflows/broken.yaml",
        "jobs:\n  - [unbalanced\n",
      ),
    ).toThrow(/\.github\/workflows\/broken\.yaml: could not be parsed as YAML/);
  });

  it("leaves the on: key a string rather than the YAML 1.1 boolean", () => {
    expect(Object.keys(parseWorkflow("wf.yaml", "on:\n  push:\n"))).toEqual([
      "on",
    ]);
  });

  it("reads a reference-shaped scalar the parser refuses as its own failure", () => {
    // A leading @ is a YAML reserved indicator, so a workflow can only hold
    // that shape quoted; the parser rejects the plain form outright.
    let thrown;
    try {
      fileReferences(
        "wf.yaml",
        "jobs:\n  build:\n    steps:\n      - uses: @v7\n",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toMatch(/wf\.yaml: could not be parsed as YAML/);
    expect(thrown?.cause?.message).toMatch(
      /cannot start with reserved character @/,
    );
  });
});

describe("tree discovery", () => {
  it("reads .yml and .yaml workflows and only action.yml/action.yaml composites", () => {
    withTree((root) => {
      write(root, ".github/workflows/a.yml", workflow("v7"));
      write(root, ".github/workflows/b.yaml", workflow("v7"));
      write(root, ".github/workflows/README.md", "not yaml\n");
      write(root, ".github/actions/setup/action.yml", composite("v6"));
      write(root, ".github/actions/setup/notes.yml", composite("v5"));

      expect(workflowFiles(root)).toEqual([
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
      ]);
      expect(compositeFiles(root)).toEqual([
        ".github/actions/setup/action.yml",
      ]);
      expect(readWorkflows(root).map(({ path }) => path)).toEqual(
        workflowFiles(root),
      );
      expect(readWorkflows(root)[0].source).toEqual(workflow("v7"));

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
    });
  });

  it("leaves a YAML file nested below the workflow directory out", () => {
    withTree((root) => {
      write(root, ".github/workflows/a.yaml", workflow("v7"));
      write(root, ".github/workflows/archive/old.yaml", workflow("v6"));
      expect(workflowFiles(root)).toEqual([".github/workflows/a.yaml"]);
    });
  });

  it("reports a tree with neither directory as holding neither", () => {
    withTree((root) => {
      expect(workflowFiles(root)).toEqual([]);
      expect(compositeFiles(root)).toEqual([]);
      expect(treeReferences(root)).toEqual({
        workflowReferences: [],
        actionReferences: [],
      });
    });
  });

  it("keeps a ref-less reference through the tree read, as written", () => {
    withTree((root) => {
      write(
        root,
        ".github/workflows/a.yml",
        "jobs:\n  build:\n    steps:\n      - uses: actions/checkout\n",
      );
      expect(treeReferences(root).workflowReferences).toEqual([
        {
          file: ".github/workflows/a.yml",
          name: "actions/checkout",
          ref: null,
        },
      ]);
    });
  });
});

describe("the real repository tree", () => {
  it("reads every workflow in it as YAML", () => {
    const workflows = readWorkflows(repoRoot);
    expect(workflows.length).toBeGreaterThan(0);
    for (const { path, source } of workflows) {
      expect(parseWorkflow(path, source)?.jobs).toBeTypeOf("object");
    }
  });

  it("reads one workflow by path", () => {
    expect(
      workflowDocument(repoRoot, ".github/workflows/static_checks.yaml").name,
    ).toBeTypeOf("string");
  });
});
