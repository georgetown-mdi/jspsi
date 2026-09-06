import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkoutOverrides,
  triggerNames,
} from "./check-checkout-ref-override.mjs";
import { parseWorkflow, readWorkflows } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const workflow = (trigger, step) => `name: Build
on:
  ${trigger}:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${step}
`;

const plainCheckout = "      - uses: actions/checkout@v7";
const withRef = `      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.head.sha }}`;

const violationsIn = (path, source) =>
  checkoutOverrides([{ path, source }]).violations;

describe("a checkout step under a pull-request trigger", () => {
  it("passes when it names no ref", () => {
    expect(
      checkoutOverrides([
        { path: "pr.yaml", source: workflow("pull_request", plainCheckout) },
      ]),
    ).toEqual({
      violations: [],
      pullRequestWorkflows: 1,
      checkoutSteps: 1,
    });
  });

  it("passes on an input that is not a ref or a sha", () => {
    expect(
      violationsIn(
        "pr.yaml",
        workflow(
          "pull_request",
          `      - uses: actions/checkout@v7
        with:
          fetch-depth: 0`,
        ),
      ),
    ).toEqual([]);
  });

  it("fails on a ref, naming the file, the step, the value, and the fix", () => {
    const violations = violationsIn(
      ".github/workflows/pr.yaml",
      workflow("pull_request", withRef),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      ".github/workflows/pr.yaml (jobs.build.steps[0]): actions/checkout sets `ref: ${{ github.event.pull_request.head.sha }}`",
    );
    expect(violations[0]).toContain("triggered by pull_request");
    expect(violations[0]).toContain("head merged with the base tip");
    expect(violations[0]).toContain("Remove the key to take the default");
  });

  it("fails on a ref that spells out the default the action would take", () => {
    expect(
      violationsIn(
        "pr.yaml",
        workflow(
          "pull_request",
          `      - uses: actions/checkout@v7
        with:
          ref: \${{ github.ref }}`,
        ),
      ),
    ).toHaveLength(1);
  });

  it("fails on a sha key, saying the action has no such input", () => {
    const violations = violationsIn(
      "pr.yaml",
      workflow(
        "pull_request",
        `      - uses: actions/checkout@v7
        with:
          sha: 1234567`,
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("actions/checkout sets `sha: 1234567`");
    expect(violations[0]).toContain("actions/checkout has no `sha` input");
  });

  it("reports a ref and a sha on one step separately", () => {
    expect(
      violationsIn(
        "pr.yaml",
        workflow(
          "pull_request",
          `      - uses: actions/checkout@v7
        with:
          ref: staging
          sha: 1234567`,
        ),
      ),
    ).toHaveLength(2);
  });

  it("holds a checkout pinned by full sha to the same rule", () => {
    expect(
      violationsIn(
        "pr.yaml",
        workflow(
          "pull_request",
          `      - uses: ACTIONS/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3
        with:
          ref: staging`,
        ),
      ),
    ).toHaveLength(1);
  });

  it("leaves an action other than checkout alone", () => {
    expect(
      violationsIn(
        "pr.yaml",
        workflow(
          "pull_request",
          `      - uses: actions/setup-node@v7
        with:
          ref: staging
      - uses: ./.github/actions/setup
        with:
          ref: staging`,
        ),
      ),
    ).toEqual([]);
  });

  it("names the job and the step index a later override sits at", () => {
    const source = `on:
  pull_request:
jobs:
  first:
    steps:
      - uses: actions/checkout@v7
  second:
    steps:
      - run: echo hello
      - uses: actions/checkout@v7
        with:
          ref: staging
`;
    const violations = violationsIn("pr.yaml", source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("pr.yaml (jobs.second.steps[1])");
  });
});

describe("which workflows the rule reaches", () => {
  it("leaves a scheduled workflow's pinned ref alone", () => {
    expect(
      checkoutOverrides([
        {
          path: "nightly.yaml",
          source: `on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
jobs:
  build:
    steps:
      - uses: actions/checkout@v7
        with:
          ref: staging
`,
        },
      ]),
    ).toEqual({ violations: [], pullRequestWorkflows: 0, checkoutSteps: 0 });
  });

  it("covers pull_request_target", () => {
    const violations = violationsIn(
      "target.yaml",
      workflow("pull_request_target", withRef),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("triggered by pull_request_target");
    expect(violations[0]).not.toContain("defaults to the head merged");
    expect(violations[0]).toContain("gate on pull_request instead");
  });

  it("reads the list and the single-name trigger forms", () => {
    expect(
      triggerNames(parseWorkflow("wf.yaml", "on: pull_request\n")),
    ).toEqual(["pull_request"]);
    expect(
      triggerNames(parseWorkflow("wf.yaml", "on: [push, pull_request]\n")),
    ).toEqual(["push", "pull_request"]);
    expect(
      violationsIn(
        "pr.yaml",
        `on: [push, pull_request]
jobs:
  build:
    steps:
${withRef}
`,
      ),
    ).toHaveLength(1);
  });

  it("fails closed on a trigger block it cannot read", () => {
    for (const source of ["jobs:\n  build:\n    steps: []\n", "on: 5\n"]) {
      const violations = violationsIn("odd.yaml", source);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(
        "odd.yaml: its `on:` block has a shape this check cannot read",
      );
    }
  });

  it("counts across every workflow it was given", () => {
    expect(
      checkoutOverrides([
        { path: "a.yaml", source: workflow("pull_request", plainCheckout) },
        {
          path: "b.yaml",
          source: workflow(
            "pull_request",
            `${plainCheckout}\n${plainCheckout}`,
          ),
        },
        { path: "c.yaml", source: workflow("push", withRef) },
      ]),
    ).toEqual({ violations: [], pullRequestWorkflows: 2, checkoutSteps: 3 });
  });
});

describe("the real repository tree", () => {
  it("has no pull-request workflow overriding the checkout ref", () => {
    const result = checkoutOverrides(readWorkflows(repoRoot));
    expect(result.violations).toEqual([]);
    expect(result.pullRequestWorkflows).toBeGreaterThan(0);
    expect(result.checkoutSteps).toBeGreaterThan(0);
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-checkout-ref-override.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Checkout ref override check passed");
  });
});
