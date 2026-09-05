import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { workflowDocument } from "./lib/workflows.mjs";

// docs/DEPLOYMENT.md's restricted-egress recipe writes five rules into the
// DOCKER-USER chain, and image_smoke.yaml's restricted_egress job applies the
// same five to the image it builds before driving the doc's verification table
// against them. Nothing but a comment holds the two copies together, and
// neither side's edit shows the other: docs/ is outside that workflow's paths
// trigger, so a doc edit runs no image job at all, while a job edit is reviewed
// against a doc nobody rereads. Either side moving alone leaves an operator
// following a recipe nothing executes, under a job still reporting the
// documented recipe green.
//
// So the two copies are extracted and compared here. This is the scripts suite,
// which static_checks.yaml runs unfiltered on every pull request -- held
// filter-free by scripts/check-merge-gate-identities.mjs -- rather than a step
// of image_smoke.yaml: a doc-only edit reaches the comparison without building
// an image or running the FIPS leg.
//
// Only the rule lines are compared. The assignments above them differ by
// design: the doc sets example addresses, the job maps its own env into the
// same four variable names, and those shared names are what hold the two in
// step. Extraction is coupled to both formats -- the doc's rules sit one per
// line inside a fenced code block, the job's inside a step's `run` block -- and
// a restructure that breaks it fails the first case below rather than comparing
// two empty lists.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const DOC = "docs/DEPLOYMENT.md";
const WORKFLOW = ".github/workflows/image_smoke.yaml";

const INSERT_RULE = /^sudo iptables -I DOCKER-USER\b/;

/**
 * The content lines of every fenced code block in a Markdown source, fence
 * lines dropped. Fences are matched the way stripFences in lib/ matches them,
 * by the opening run of backticks alone.
 */
function fencedBlocks(markdown) {
  const blocks = [];
  let open = null;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (open === null) open = [];
      else {
        blocks.push(open);
        open = null;
      }
      continue;
    }
    if (open !== null) open.push(line);
  }
  return blocks;
}

/** The DOCKER-USER insert rules among `lines`, indentation removed. */
function insertRules(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => INSERT_RULE.test(line));
}

/** Every fenced block of the doc that writes DOCKER-USER insert rules. */
function documentedBlocks() {
  return fencedBlocks(readFileSync(resolve(REPO_ROOT, DOC), "utf8"))
    .map(insertRules)
    .filter((rules) => rules.length > 0);
}

/** Every `run` step of the workflow that writes DOCKER-USER insert rules. */
function applyingSteps() {
  const document = workflowDocument(REPO_ROOT, WORKFLOW);
  return Object.values(document.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step?.run === "string")
    .map((step) => ({
      name: step.name,
      rules: insertRules(step.run.split("\n")),
    }))
    .filter((step) => step.rules.length > 0);
}

describe("the restricted-egress DOCKER-USER allowlist", () => {
  it("is written in one place on each side", () => {
    expect(
      documentedBlocks().length,
      `${DOC} should hold the DOCKER-USER insert rules in exactly one fenced code block. A recipe split across blocks, or written other than one rule per line, cannot be compared against ${WORKFLOW}.`,
    ).toBe(1);
    expect(
      applyingSteps().map((step) => step.name),
      `${WORKFLOW} should apply the DOCKER-USER insert rules in exactly one step's run block, so there is one copy to compare against ${DOC}.`,
    ).toHaveLength(1);
  });

  it("reads the same in the doc and in the job that drives it", () => {
    const [documented] = documentedBlocks();
    const [applied] = applyingSteps();
    expect(
      applied.rules,
      `${DOC} and ${WORKFLOW} disagree on the rules the restricted-egress recipe writes into DOCKER-USER. The job drives the doc's recipe against the image, so both sides move together or neither does.`,
    ).toEqual(documented);
  });
});
