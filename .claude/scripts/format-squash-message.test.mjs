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
});

// One case per marker the normalizer takes out. Each body normalizes to the
// text beside it, the subject unchanged.
const NORMALIZED = [
  {
    name: "a heading marker, whose line becomes a paragraph",
    body: "## Motivation\nThe rules had two copies.",
    want: "Motivation\n\nThe rules had two copies.",
  },
  {
    name: "asterisk emphasis",
    body: "This is **strong** and *slanted* text.",
    want: "This is strong and slanted text.",
  },
  {
    name: "underscore emphasis, leaving an identifier alone",
    body: "This is __strong__ and _slanted_, unlike snake_case_name.",
    want: "This is strong and slanted, unlike snake_case_name.",
  },
  {
    name: "an inline code span",
    body: "This names `a code span` in a body.",
    want: "This names a code span in a body.",
  },
  {
    name: "a link, whose url follows the text",
    body: "See [the design](docs/DESIGN.md) for context.",
    want: "See the design (docs/DESIGN.md) for context.",
  },
  {
    name: "a link whose text already holds the url",
    body: "See [docs/DESIGN.md](docs/DESIGN.md) for context.",
    want: "See docs/DESIGN.md for context.",
  },
  {
    name: "a code fence, whose line is dropped whole",
    body: "```\nA sentence the run wrapped in a fence.\n```",
    want: "A sentence the run wrapped in a fence.",
  },
  {
    name: "a blockquote marker",
    body: "> A quoted line.",
    want: "A quoted line.",
  },
  {
    name: "a bullet item, which becomes its own paragraph",
    body: "- first point\n* second point\n+ third point",
    want: "first point\n\nsecond point\n\nthird point",
  },
  {
    name: "a numbered item in either spelling",
    body: "1. first point\n2) second point",
    want: "first point\n\nsecond point",
  },
  {
    name: "an item's continuation lines, joined into it",
    body: "- first point\n  continued on the next line",
    want: "first point continued on the next line",
  },
  {
    name: "a nested item, which rides with its parent paragraph",
    body: "- first point\n  - a point under it",
    want: "first point a point under it",
  },
  {
    name: "a list under a lead-in line, which stays a paragraph",
    body: "The points:\n- one\n- two",
    want: "The points:\n\none\n\ntwo",
  },
  {
    name: "a list under a heading, with no blank line between them",
    body: "## Steps\n- one\n- two",
    want: "Steps\n\none\n\ntwo",
  },
  {
    name: "a numbered list under a heading",
    body: "## Steps\n1. one\n2. two",
    want: "Steps\n\none\n\ntwo",
  },
  {
    name: "a list under a lead-in whose colon is inside emphasis",
    body: "**The points:**\n- one\n- two",
    want: "The points:\n\none\n\ntwo",
  },
  {
    name: "prose whose wrapped line opens on a year",
    body: "The release landed and\n2026. The next one is in May.",
    want: "The release landed and 2026. The next one is in May.",
  },
];

describe("format-squash-message normalizing", () => {
  for (const { name, body, want } of NORMALIZED) {
    it(`takes out ${name}`, () => {
      expect(normalizeDraft(draft(body))).toBe(`${SUBJECT}\n\n${want}\n`);
      expect(refusals(draft(body), 1374)).toEqual([]);
    });
  }

  it("puts in the blank line under the subject the draft is missing", () => {
    expect(normalizeDraft(`${SUBJECT}\nBody sentence.\n`)).toBe(
      `${SUBJECT}\n\nBody sentence.\n`,
    );
  });

  it("takes the markers out of the subject without reflowing it", () => {
    expect(normalizeDraft("## `Fix` the **thing**\n\nBody.\n")).toBe(
      "Fix the thing\n\nBody.\n",
    );
  });

  it("is a fixed point: normalizing its own output changes nothing", () => {
    const drafts = [
      draft(`${"word ".repeat(40)}end`),
      `${SUBJECT}\nBody sentence.\n`,
      ...NORMALIZED.map(({ body }) => draft(body)),
    ];
    for (const source of drafts) {
      const once = normalizeDraft(source);
      expect(normalizeDraft(once), source).toBe(once);
      expect(violations(once, 1374), source).toEqual([]);
    }
  });
});

// Draft shapes the normalizer must leave nothing in for its own check to
// report: every marker kind above, plus the combinations a `claude -p` answer
// arrives in -- a list under a heading, a nested item, a fence around prose, an
// indented block, a paragraph written at some other width.
const CORPUS = [
  ...NORMALIZED.map(({ body }) => body),
  "## Steps\n- one\n  - nested under one\n- two\n\nClosing prose.",
  "Intro line.\n## A heading mid-block\n- one\n- two",
  "The points:\n1. one\n2) two\n\n> a quoted line\n\n```\na fenced line\n```",
  "See [the design](docs/DESIGN.md):\n- **first** point\n- `second` point",
  "  psilink exchange --config a.yaml\n  psilink doctor",
  "## Heading\n\n    an indented block under it",
  "## Heading\n- item\n\n    an indented block after the list",
  `${"word ".repeat(40)}end`,
  `Lead-in:\n- ${"word ".repeat(30)}end\n- second`,
  "A paragraph.\n\n## Another heading\n+ plus item\n+ another",
];

describe("format-squash-message normalized output", () => {
  it("leaves nothing for the check to report, whatever the shape", () => {
    for (const body of CORPUS) {
      const once = normalizeDraft(draft(body));
      expect(violations(once, 1374), body).toEqual([]);
      expect(normalizeDraft(once), body).toBe(once);
    }
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

  it("measures the subject the normalizer produces, markers gone", () => {
    const subject = "x".repeat(subjectBudget(1374));
    expect(refusals(`\`${subject}\`\n\nBody.\n`, 1374)).toEqual([]);
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

  it("refuses an over-wide line inside an indented block", () => {
    const found = refusedFor(`  ${"x".repeat(BODY_WRAP_COLUMNS)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Indented");
  });

  it("refuses an empty draft", () => {
    expect(refusals("   \n\n", 1374)).toHaveLength(1);
  });

  it("refuses nothing normalizing can fix without losing a word", () => {
    for (const { body } of NORMALIZED) {
      expect(refusedFor(body), body).toEqual([]);
    }
    expect(refusals(`${SUBJECT}\nBody sentence.\n`, 1374)).toEqual([]);
    expect(refusedFor(`${"word ".repeat(30)}end`)).toEqual([]);
  });

  it("passes a message shaped the way this repository writes them", () => {
    const body =
      "Squash drafts reached the maintainer with unwrapped body lines,\n" +
      "because both producers stated the rule in prose and nothing\n" +
      "checked the result.";
    expect(refusedFor(body)).toEqual([]);
    expect(violations(normalizeDraft(draft(body)), 1374)).toEqual([]);
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

  it("names the markdown, the list, and the missing blank line", () => {
    expect(violations(draft("## Motivation"), 1374)[0]).toContain(
      "no markdown",
    );
    expect(violations(draft("- first point"), 1374)[0]).toContain(
      "prose, not a list",
    );
    expect(violations(`${SUBJECT}\nBody sentence.\n`, 1374)[0]).toContain(
      "blank",
    );
  });

  it("reports a draft no rule names but the normalizer still changes", () => {
    const found = violations(`${SUBJECT}\n\nBody sentence.\n\n\n`, 1374);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("normalizer produces");
  });

  // A body wrapped by hand at some narrower column is not what the normalizer
  // produces, so the gate is byte identity with its output rather than "every
  // line fits": the file is written by the normalizer, and an edit that leaves
  // the paragraph short is one command away from normalized again.
  it("reports a paragraph hand-wrapped narrower than the column", () => {
    const body = "A body sentence broken\nearly, well under the column.";
    expect(violations(draft(body), 1374)).toHaveLength(1);
    expect(violations(normalizeDraft(draft(body)), 1374)).toEqual([]);
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

  it("takes the markers out rather than refusing over them", () => {
    const result = run(["1374"], draft("- a list item with `a code span`"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${SUBJECT}\n\na list item with a code span\n`);
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
    const subject = "x".repeat(subjectBudget(1374) + 1);
    const result = run(["1374", "--out", target], `${subject}\n\nBody.\n`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Shorten the subject");
    expect(result.stderr).toContain("Nothing was written");
    expect(() => readFileSync(target, "utf8")).toThrow();
  });

  // The check over its own output has one shape that reaches it: the wrap put a
  // marker at the front of a line whose line above ends in a colon, which the
  // next pass reads as a list. The run fails there rather than write a message
  // the hook over the file would refuse.
  it("writes nothing when its own check rejects what it produced", () => {
    const directory = tempDirectory();
    const target = join(directory, "1374.txt");
    const body = `${"word ".repeat(12)}budget: 12. A sentence the wrap pushes onto the next line.`;
    const result = run(["1374", "--out", target], draft(body));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bug in the script");
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

/**
 * The recent commits that landed through a squash merge, each as the draft it
 * would have been written from: the suffix GitHub appended taken back off. `git
 * log` ends each record with the NUL and then a newline, so the newline opening
 * every record after the first is dropped -- keeping it leaves a blank subject
 * line and a corpus that matches nothing.
 */
function landedCommits(count) {
  const log = execFileSync(
    "git",
    ["-C", REPO_ROOT, "log", `-${count}`, "--format=%s%n%n%b%x00"],
    { encoding: "utf8" },
  );
  return log
    .split("\0")
    .map((message) => message.replace(/^\n/, ""))
    .filter((message) => message.trim() !== "")
    .flatMap((message) => {
      const landed = /^(?<subject>.*?)(?<suffix> \(#(?<number>\d+)\))?$/.exec(
        message.split("\n")[0],
      );
      if (landed.groups.number === undefined) return [];
      return [
        {
          subject: landed.groups.subject,
          message: message.replace(landed.groups.suffix, ""),
          prNumber: Number(landed.groups.number),
        },
      ];
    });
}

/**
 * The problems reported about a message's body. STATED LIMIT: subjects that
 * landed before this budget was checked run past it, so the history proves the
 * body rules only; the subject budget is measured on its own above.
 */
const bodyProblems = (found) =>
  found.filter((problem) => !problem.startsWith("The subject is"));

describe("format-squash-message against real commit messages", () => {
  // The repository's own recent history is the only corpus that proves the
  // rules do not fire on messages written under them.
  const landed = landedCommits(50);

  it("reads a corpus of messages rather than an empty list", () => {
    expect(landed.length).toBeGreaterThan(10);
  });

  it("refuses no body among the last fifty commits", () => {
    for (const { subject, message, prNumber } of landed) {
      expect(
        bodyProblems(formatDraft(message, prNumber).refusals),
        subject,
      ).toEqual([]);
    }
  });

  it("leaves nothing for the check to report on what it normalizes", () => {
    for (const { subject, message, prNumber } of landed) {
      const once = normalizeDraft(message);
      expect(bodyProblems(violations(once, prNumber)), subject).toEqual([]);
      expect(normalizeDraft(once), subject).toBe(once);
    }
  });
});
