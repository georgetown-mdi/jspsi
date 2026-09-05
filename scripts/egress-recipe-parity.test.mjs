import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fencedBlocks, isFenceLine } from "./lib/markdownFences.mjs";
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
//
// The doc side is read with the shared fence reader in lib/, which closes a
// block only on a fence CommonMark closes it with, so the opening fence of the
// block below a missing close stays content of the block above it and is
// reported. A scanner that toggles on every bare ``` instead re-pairs around
// that missing close -- the next block's opening fence closes the recipe, every
// fence after it swaps role, and the same five rules still extract -- so
// nothing reports the malformed doc. The last two cases below hold that open.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const DOC = "docs/DEPLOYMENT.md";
const WORKFLOW = ".github/workflows/image_smoke.yaml";

const INSERT_RULE = /^sudo iptables -I DOCKER-USER\b/;

/** The doc as the fence reader takes it. */
const docSource = () => readFileSync(resolve(REPO_ROOT, DOC), "utf8");

/** The DOCKER-USER insert rules among `lines`, indentation removed. */
function insertRules(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => INSERT_RULE.test(line));
}

/** Every fenced block of a Markdown source that writes DOCKER-USER insert rules. */
const recipeBlocks = (markdown) =>
  fencedBlocks(markdown).filter(
    (block) => insertRules(block.code.split("\n")).length > 0,
  );

/** The insert rules each of those blocks writes. */
const documentedRules = (markdown) =>
  recipeBlocks(markdown).map((block) => insertRules(block.code.split("\n")));

/**
 * The lines of a Markdown source holding a fence the parse could not pair: one
 * read as a block's content, which is where the opening fence below a missing
 * close lands, and the opening fence of a block that runs to the end of the
 * file.
 */
function unpairedFences(markdown) {
  const lines = [];
  for (const block of fencedBlocks(markdown)) {
    block.code.split("\n").forEach((line, index) => {
      if (isFenceLine(line)) lines.push(block.startLine + index);
    });
    if (!block.closed) lines.push(block.startLine - 1);
  }
  return lines.sort((a, b) => a - b);
}

/** The doc with the recipe block's own closing fence line deleted. */
function withoutRecipeClosingFence(markdown) {
  const lines = markdown.split("\n");
  const [recipe] = recipeBlocks(markdown);
  const closing = recipe.startLine - 1 + recipe.code.split("\n").length;
  if (!isFenceLine(lines[closing] ?? "")) {
    throw new Error(
      `${DOC}:${closing + 1} is not the recipe block's closing fence; this case can no longer remove one.`,
    );
  }
  lines.splice(closing, 1);
  return lines.join("\n");
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
      documentedRules(docSource()).length,
      `${DOC} should hold the DOCKER-USER insert rules in exactly one fenced code block. A recipe split across blocks, or written other than one rule per line, cannot be compared against ${WORKFLOW}.`,
    ).toBe(1);
    expect(
      applyingSteps().map((step) => step.name),
      `${WORKFLOW} should apply the DOCKER-USER insert rules in exactly one step's run block, so there is one copy to compare against ${DOC}.`,
    ).toHaveLength(1);
  });

  it("reads the same in the doc and in the job that drives it", () => {
    const [documented] = documentedRules(docSource());
    const [applied] = applyingSteps();
    expect(
      applied.rules,
      `${DOC} and ${WORKFLOW} disagree on the rules the restricted-egress recipe writes into DOCKER-USER. The job drives the doc's recipe against the image, so both sides move together or neither does.`,
    ).toEqual(documented);
  });

  it("is read out of a doc whose fences all pair", () => {
    expect(
      unpairedFences(docSource()),
      `${DOC} holds a fence the parse could not pair, at the lines reported, so the rules above were read out of a block running past its own recipe.`,
    ).toEqual([]);
  });

  it("reports the recipe's closing fence when it goes missing", () => {
    const damaged = withoutRecipeClosingFence(docSource());
    expect(
      documentedRules(damaged),
      "a recipe block that runs past its own close still yields the same five rules, which is why the comparison above cannot catch the missing fence",
    ).toEqual(documentedRules(docSource()));
    expect(
      unpairedFences(damaged),
      `a ${DOC} whose recipe block never closes should be reported by the case above rather than left to extract as a healthy doc.`,
    ).not.toEqual([]);
  });
});
