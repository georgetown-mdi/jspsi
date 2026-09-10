import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { titleViolations } from "../../scripts/check-pr-checklist.mjs";
import { refusals, subjectBudget } from "../scripts/format-squash-message.mjs";

const HOOK = fileURLToPath(
  new URL("./block-over-budget-pr-title.mjs", import.meta.url),
);

/** The budget for a pull request whose number is not known yet. */
const UNNUMBERED_BUDGET = subjectBudget(null);

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude, so both are expected outcomes here
// and neither may throw.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function verdict(command) {
  return runHook({ tool_name: "Bash", tool_input: { command } });
}

function expectBlocked(commands) {
  for (const command of commands) {
    const { status, stderr } = verdict(command);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-over-budget-pr-title");
  }
}

function expectAllowed(commands) {
  for (const command of commands) {
    expect(verdict(command).status, command).toBe(0);
  }
}

/** A title of exactly `length` characters, holding no character to quote. */
function title(length) {
  return "T".repeat(length);
}

describe("block-over-budget-pr-title hook", () => {
  it("holds the budget CONTRIBUTING.md quotes for a title", () => {
    expect(UNNUMBERED_BUDGET).toBe(42);
  });

  it("ignores tools other than Bash", () => {
    const { status } = runHook({
      tool_name: "Agent",
      tool_input: { prompt: `gh pr create --title "${title(80)}"` },
    });
    expect(status).toBe(0);
  });

  it("blocks an over-budget title on create and on edit", () => {
    expectBlocked([
      `gh pr create --title "${title(UNNUMBERED_BUDGET + 1)}" --body ok`,
      `gh pr edit --title "${title(80)}"`,
      `gh pr new --title "${title(80)}"`,
      `git push -u origin work && gh pr create --title "${title(80)}"`,
    ]);
  });

  it("names the measured length, the budget and the squash subject", () => {
    const { stderr } = verdict(`gh pr create --title "${title(57)}"`);
    expect(stderr).toContain("57 characters");
    expect(stderr).toContain(`budget is ${UNNUMBERED_BUDGET}`);
    expect(stderr).toContain("squash-merges");
    expect(stderr).toContain(" (#NNNN)");
    expect(stderr).toContain("no number yet");
  });

  it("allows a title that fits, at the boundary and under it", () => {
    expectAllowed([
      `gh pr create --title "${title(UNNUMBERED_BUDGET)}"`,
      `gh pr create --title "${title(1)}" --body "a body"`,
      "gh pr create --fill",
    ]);
  });

  it("reads the title flag in every form gh takes it", () => {
    expectBlocked([
      `gh pr create --title="${title(80)}"`,
      `gh pr create -t "${title(80)}"`,
      `gh pr create -t="${title(80)}"`,
      `gh pr create -t${title(80)}`,
      `gh pr create -t"${title(80)}"`,
    ]);
  });

  it("reads a structural word written quoted", () => {
    expectBlocked([
      `"gh" pr create --title "${title(80)}"`,
      `gh pr "create" --title "${title(80)}"`,
      `gh pr create "--title" "${title(80)}"`,
      `gh pr create "--title=${title(80)}"`,
    ]);
  });

  it("counts a quote character the title itself holds", () => {
    const written = `Don't ${title(UNNUMBERED_BUDGET - 5)}`;
    expect(written.length).toBe(UNNUMBERED_BUDGET + 1);
    expect(written.replaceAll("'", "").length).toBe(UNNUMBERED_BUDGET);
    expectBlocked([
      `gh pr create --title "${written}"`,
      `gh pr create --title="${written}"`,
      `"gh" "pr" "create" "--title" "${written}"`,
    ]);
  });

  it("takes the exact suffix from the pull request an edit names", () => {
    const budget = subjectBudget(928);
    expect(budget).toBe(UNNUMBERED_BUDGET + 1);
    expectAllowed([
      `gh pr edit 928 --title "${title(budget)}"`,
      `gh pr edit https://github.com/georgetown-mdi/jspsi/pull/928 --title "${title(budget)}"`,
    ]);
    expectBlocked([`gh pr edit 928 --title "${title(budget + 1)}"`]);
    expect(verdict(`gh pr edit 928 --title "${title(80)}"`).stderr).toContain(
      " (#928)",
    );
  });

  it("leaves every other command alone", () => {
    expectAllowed([
      `gh issue create --title "${title(80)}"`,
      `gh project item-create 10 --title "${title(80)}"`,
      `gh pr list --search "${title(80)}"`,
      `git commit -m "${title(80)}"`,
      `echo "gh pr create --title ${title(80)}"`,
    ]);
  });

  it("does not read a command quoted inside another flag's value", () => {
    expectAllowed([
      `gh pr create --title "Short enough" --body "run gh pr create --title '${title(80)}'"`,
    ]);
  });

  it("leaves a shorthand cluster to the checklist run, as its header states", () => {
    expectAllowed([`gh pr create -dt "${title(80)}"`]);
  });

  it("allows a malformed or absent payload rather than wedging Bash", () => {
    const { status } = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(runHook({ tool_name: "Bash", tool_input: {} }).status).toBe(0);
    expect(runHook({ tool_name: "Bash" }).status).toBe(0);
    expectAllowed(["gh pr create --title", "gh pr", "gh pr create"]);
  });
});

// Three readers measure one budget: this hook when the title is written, the PR
// checklist check on the open pull request, and the normalizer on the squash
// draft. A title one of them accepts and another fails costs a red run and a
// retitle, so the boundary itself is pinned across all three.
describe("the readers of the subject budget", () => {
  const PR = "1274";
  const budget = subjectBudget(PR);

  /** A one-paragraph squash draft under `subject`, clean but for its length. */
  function draft(subject) {
    return `${subject}\n\nA body sentence for the draft.\n`;
  }

  it("agree on a title of exactly the budget", () => {
    const fitting = title(budget);
    expect(verdict(`gh pr edit ${PR} --title "${fitting}"`).status).toBe(0);
    expect(titleViolations(fitting, PR)).toEqual([]);
    expect(refusals(draft(fitting), PR)).toEqual([]);
  });

  it("agree on a title one character over the budget", () => {
    const overlong = title(budget + 1);
    expect(verdict(`gh pr edit ${PR} --title "${overlong}"`).status).toBe(2);
    expect(titleViolations(overlong, PR)).toHaveLength(1);
    expect(refusals(draft(overlong), PR)).toHaveLength(1);
  });
});
