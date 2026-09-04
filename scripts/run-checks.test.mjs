import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHECKS,
  OUT_OF_CHECK_ALL,
  SEPARATE_WORKFLOW_STEPS,
  inventory,
  rootScripts,
  summarize,
} from "./run-checks.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = `${WORKFLOW_DIR}/static_checks.yaml`;
const GUARD_JOB = "repo-guards";

const scripts = rootScripts(ROOT);

function guardJobSteps() {
  const workflow = workflowDocument(ROOT, WORKFLOW);
  return workflow.jobs[GUARD_JOB].steps;
}

describe("the check:all list against the root package.json", () => {
  it("classifies every check:* script as run or not run, and nothing twice", () => {
    const declared = Object.keys(scripts).filter(
      (name) => name.startsWith("check:") && name !== "check:all",
    );
    const classified = [
      ...CHECKS.map((check) => check.script),
      ...OUT_OF_CHECK_ALL.map((check) => check.script),
    ];

    expect(new Set(classified).size).toBe(classified.length);
    expect(
      declared.filter((name) => !classified.includes(name)),
      "a check:* script the runner neither runs nor states a reason for skipping: add it to CHECKS with a one-line description, or to OUT_OF_CHECK_ALL with what keeps it off the list",
    ).toEqual([]);
  });

  it("names only scripts that exist", () => {
    for (const entry of [...CHECKS, ...OUT_OF_CHECK_ALL]) {
      expect(
        Object.keys(scripts),
        `${entry.script} is not a root package.json script`,
      ).toContain(entry.script);
    }
  });

  it("gives every check it runs a one-line description", () => {
    for (const check of CHECKS) {
      expect(check.description.trim(), check.script).not.toBe("");
      expect(check.description, check.script).not.toContain("\n");
    }
  });

  it("gives every excluded check a reason", () => {
    for (const check of OUT_OF_CHECK_ALL) {
      expect(check.reason.trim(), check.script).not.toBe("");
    }
  });

  it("runs the runner from check:all", () => {
    expect(scripts["check:all"]).toBe("node scripts/run-checks.mjs");
  });
});

describe("the repo-guards job against the list", () => {
  it("runs the checks through check:all and nothing else beside the audit", () => {
    const commands = guardJobSteps()
      .map((step) => step.run)
      .filter((run) => typeof run === "string")
      .map((run) => run.trim());
    const separate = SEPARATE_WORKFLOW_STEPS.map((step) => step.command);

    expect(commands).toContain("npm run check:all");
    for (const command of commands) {
      if (command === "npm run check:all") continue;
      expect(
        separate.some((allowed) => command.startsWith(allowed)),
        `${WORKFLOW}'s ${GUARD_JOB} job runs \`${command}\` as a step of its own. A repository check belongs in scripts/run-checks.mjs's list, which check:all drives, so that it runs locally too; a step that cannot go there is added to SEPARATE_WORKFLOW_STEPS with the reason.`,
      ).toBe(true);
    }
  });

  it("hands the merge-gate check a token to read the branch rules with", () => {
    const step = guardJobSteps().find(
      (candidate) => candidate.run?.trim() === "npm run check:all",
    );
    expect(step.env?.GITHUB_TOKEN).toBeTruthy();
  });
});

describe("reporting", () => {
  it("names every failed check in the summary and counts the passes", () => {
    const summary = summarize([
      { script: "linkcheck", ok: true, seconds: 1.24 },
      { script: "check:vectors", ok: false, seconds: 9.5 },
      { script: "test:scripts", ok: false, seconds: 30 },
    ]);

    expect(summary).toContain("1 of 3 checks passed in 40.7s.");
    expect(summary).toContain("Failed: check:vectors, test:scripts.");
    expect(summary).toContain("pass  linkcheck");
  });

  it("lists what runs and what does not with its reason", () => {
    const listed = inventory();

    for (const check of CHECKS) expect(listed).toContain(check.script);
    for (const check of OUT_OF_CHECK_ALL) {
      expect(listed).toContain(check.script);
      expect(listed).toContain(check.reason);
    }
  });
});
