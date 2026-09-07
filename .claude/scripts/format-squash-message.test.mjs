import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BODY_WRAP_COLUMNS,
  SUBJECT_LIMIT,
  formatDraft,
  normalizeDraft,
  parseArgs,
  refusals,
  splitDraft,
  subjectBudget,
  violations,
  wrapParagraph,
} from "./format-squash-message.mjs";

const SCRIPT = fileURLToPath(
  new URL("./format-squash-message.mjs", import.meta.url),
);
const REPO_ROOT = join(dirname(SCRIPT), "..", "..");

const directories = [];
afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop(), { recursive: true, force: true });
  }
});

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "format-squash-"));
  directories.push(directory);
  return directory;
}

/** Run the script the way a session does, returning its streams and status. */
function run(args, input = "") {
  return spawnSync("node", [SCRIPT, ...args], { input, encoding: "utf8" });
}

const SUBJECT = "Make the squash-message wrap structural";
const draft = (body) => `${SUBJECT}\n\n${body}\n`;
const bodyLines = (text) => splitDraft(text).body.filter((l) => l !== "");

describe("format-squash-message wrapping", () => {
  it("rewraps a paragraph written at 120 columns", () => {
    const paragraph = Array.from({ length: 24 }, (_, i) => `word${i}`).join(
      " ",
    );
    const wide = `${paragraph} ${paragraph}`;
    expect(wide.length).toBeGreaterThan(120);

    const normalized = normalizeDraft(draft(wide));
    for (const line of bodyLines(normalized)) {
      expect(line.length).toBeLessThanOrEqual(BODY_WRAP_COLUMNS);
    }
    expect(bodyLines(normalized).join(" ")).toBe(wide);
  });

  it("never rewraps or reflows the subject line", () => {
    const long =
      "A subject line far past every column budget in this repository";
    const normalized = normalizeDraft(`${long}\n\nBody sentence.\n`);
    expect(normalized.split("\n")[0]).toBe(long);
  });

  it("keeps paragraphs apart and collapses repeated blank lines", () => {
    const normalized = normalizeDraft(
      `${SUBJECT}\n\n\nFirst.\n\n\n\nSecond.\n`,
    );
    expect(normalized).toBe(`${SUBJECT}\n\nFirst.\n\nSecond.\n`);
  });

  it("leaves an indented block exactly as it was written", () => {
    const block = "  psilink exchange --config a.yaml\n  psilink doctor";
    expect(normalizeDraft(draft(block))).toBe(`${SUBJECT}\n\n${block}\n`);
  });

  it("gives a word longer than the budget a line of its own", () => {
    const word = "x".repeat(BODY_WRAP_COLUMNS + 20);
    const lines = wrapParagraph(`start ${word} end`);
    expect(lines).toEqual(["start", word, "end"]);
  });

  it("is a fixed point: normalizing its own output changes nothing", () => {
    const wide = `${"word ".repeat(40)}end`;
    const once = normalizeDraft(draft(wide));
    expect(normalizeDraft(once)).toBe(once);
    expect(violations(once, 1374)).toEqual([]);
  });
});

describe("format-squash-message subject budget", () => {
  it("counts the suffix GitHub appends, not the bare subject", () => {
    expect(subjectBudget(1374)).toBe(SUBJECT_LIMIT - " (#1374)".length);
    const subject = "x".repeat(subjectBudget(1374));
    expect(refusals(`${subject}\n\nBody.\n`, 1374)).toEqual([]);
    expect(refusals(`${subject}x\n\nBody.\n`, 1374)).toHaveLength(1);
    expect(refusals(`${subject}x\n\nBody.\n`, 1374)[0]).toContain("(#1374)");
  });

  it("assumes a four-digit suffix when the number is unknown", () => {
    expect(subjectBudget(null)).toBe(SUBJECT_LIMIT - " (#NNNN)".length);
  });

  it("takes a wider budget for a shorter pull-request number", () => {
    expect(subjectBudget(7)).toBeGreaterThan(subjectBudget(1374));
    const subject = "x".repeat(subjectBudget(7));
    expect(refusals(`${subject}\n\nBody.\n`, 7)).toEqual([]);
    expect(refusals(`${subject}\n\nBody.\n`, 1374)).toHaveLength(1);
  });

  it("agrees with the budget CONTRIBUTING.md states in prose", () => {
    const contributing = readFileSync(
      join(REPO_ROOT, "CONTRIBUTING.md"),
      "utf8",
    );
    expect(contributing).toContain(`roughly ${subjectBudget(null)} characters`);
    expect(contributing).toContain(`${SUBJECT_LIMIT} characters or fewer`);
  });
});

describe("format-squash-message refusals", () => {
  const refusedFor = (body) => refusals(draft(body), 1374);

  it("refuses markdown a commit message does not take", () => {
    for (const body of [
      "## Motivation",
      "This is **emphasis** in a body.",
      "This names `a code span` in a body.",
      "See [the design](docs/DESIGN.md) for context.",
      "```\ncode\n```",
      "> quoted line",
    ]) {
      expect(refusedFor(body), body).not.toEqual([]);
      expect(refusedFor(body)[0], body).toContain("no markdown");
    }
  });

  it("refuses a top-level list", () => {
    for (const body of ["- first point", "* first point", "1. first point"]) {
      expect(refusedFor(body), body).not.toEqual([]);
      expect(refusedFor(body)[0], body).toContain("prose, not a list");
    }
  });

  it("refuses a body that starts on the line under the subject", () => {
    const found = refusals(`${SUBJECT}\nBody sentence.\n`, 1374);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("blank");
  });

  it("refuses an over-wide line inside an indented block", () => {
    const found = refusedFor(`  ${"x".repeat(BODY_WRAP_COLUMNS)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Indented");
  });

  it("refuses an empty draft", () => {
    expect(refusals("   \n\n", 1374)).toHaveLength(1);
  });

  it("passes a message shaped the way this repository writes them", () => {
    const body =
      "Squash drafts reached the maintainer with unwrapped body lines,\n" +
      "because both producers stated the rule in prose and nothing\n" +
      "checked the result.";
    expect(refusedFor(body)).toEqual([]);
    expect(violations(draft(body), 1374)).toEqual([]);
  });
});

describe("format-squash-message violations", () => {
  it("reports the wrap a producer that cannot rewrite must refuse", () => {
    const wide = `${"word ".repeat(30)}end`;
    expect(refusals(draft(wide), 1374)).toEqual([]);
    expect(violations(draft(wide), 1374)).toHaveLength(1);
    expect(violations(draft(wide), 1374)[0]).toContain(
      String(BODY_WRAP_COLUMNS),
    );
  });

  it("exempts a single unbreakable word, which no wrap can shorten", () => {
    const word = "x".repeat(BODY_WRAP_COLUMNS + 20);
    expect(violations(draft(word), 1374)).toEqual([]);
  });
});

describe("format-squash-message arguments", () => {
  it("takes a bare number, the #-prefixed spelling, and unassigned", () => {
    expect(parseArgs(["1374"]).prNumber).toBe(1374);
    expect(parseArgs(["#1374"]).prNumber).toBe(1374);
    expect(parseArgs(["unassigned"]).prNumber).toBeNull();
  });

  it("reads a draft path and an --out path in either spelling", () => {
    expect(parseArgs(["7", "/tmp/a.txt", "--out", "/tmp/b.txt"])).toEqual({
      prNumber: 7,
      input: "/tmp/a.txt",
      out: "/tmp/b.txt",
    });
    expect(parseArgs(["7", "--out=/tmp/b.txt"]).out).toBe("/tmp/b.txt");
  });

  it("refuses an argument list it cannot read", () => {
    for (const argv of [
      [],
      ["abc"],
      ["0"],
      ["-3"],
      ["7", "a.txt", "b.txt"],
      ["7", "--out"],
      ["7", "--verbose"],
    ]) {
      expect(parseArgs(argv), JSON.stringify(argv)).toBeNull();
    }
  });
});

describe("format-squash-message as a command", () => {
  it("normalizes a draft read from stdin onto stdout", () => {
    const wide = `${"word ".repeat(30)}end`;
    const result = run(["1374"], draft(wide));
    expect(result.status).toBe(0);
    for (const line of bodyLines(result.stdout)) {
      expect(line.length).toBeLessThanOrEqual(BODY_WRAP_COLUMNS);
    }
  });

  it("writes the normalized draft to --out and nothing to stdout", () => {
    const directory = tempDirectory();
    const source = join(directory, "draft.txt");
    const target = join(directory, "1374.txt");
    writeFileSync(source, draft(`${"word ".repeat(30)}end`));

    const result = run(["1374", source, "--out", target]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(target, "utf8")).toBe(
      normalizeDraft(readFileSync(source, "utf8")),
    );
  });

  it("writes nothing at all when the draft is refused", () => {
    const directory = tempDirectory();
    const target = join(directory, "1374.txt");
    const result = run(["1374", "--out", target], draft("- a list item"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("prose, not a list");
    expect(result.stderr).toContain("Nothing was written");
    expect(() => readFileSync(target, "utf8")).toThrow();
  });

  it("prints its usage rather than guessing at a bad argument list", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("format-squash-message against real commit messages", () => {
  // The repository's own recent history is the only corpus that proves the
  // refusals do not fire on messages written under the rules they encode.
  it("refuses none of the last fifty commits on this branch", () => {
    const log = execFileSync(
      "git",
      ["-C", REPO_ROOT, "log", "-50", "--format=%s%n%n%b%x00"],
      { encoding: "utf8" },
    );
    for (const message of log.split("\0").filter((m) => m.trim() !== "")) {
      const landed = /^(?<subject>.*?)(?<suffix> \(#(?<number>\d+)\))?$/.exec(
        message.split("\n")[0],
      );
      if (landed.groups.number === undefined) continue;
      const withoutSuffix = message.replace(landed.groups.suffix, "");
      expect(
        formatDraft(withoutSuffix, Number(landed.groups.number)).refusals,
        landed.groups.subject,
      ).toEqual([]);
    }
  });
});
