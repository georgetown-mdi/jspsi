import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attestationViolations,
  bodyViolations,
  checklistViolations,
  prHeadSha,
  stripHtmlComments,
  titleBudget,
  titleViolations,
} from "./check-pr-checklist.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

// A minimal resolved body in the template's shape: every required line present,
// checked, carrying a resolution clause, and attesting the head it reviewed.
const passingBody = `## Summary

Deliver the thing.

## Checklist

- [x] Docs: enumerated \`docs/\` and \`docs/spec/\` and updated affected pages (\`/docs\` high level + design; \`/docs/spec\` low level + details) -- updated docs/CLI.md
- [x] CHANGELOG.md [Unreleased] updated -- n/a: bug fix, not a major feature
- [x] Security review of ${HEAD} -- n/a: none of the listed surfaces touched
`;

describe("PR checklist guard", () => {
  it("passes a fully resolved checklist", () => {
    expect(checklistViolations(passingBody)).toEqual([]);
  });

  it("flags an unchecked box", () => {
    const body = passingBody.replace(
      "- [x] Security review",
      "- [ ] Security review",
    );
    const v = checklistViolations(body);
    expect(v.some((m) => m.includes("unchecked box"))).toBe(true);
  });

  it("flags a deleted required line", () => {
    const body = passingBody
      .split("\n")
      .filter((line) => !line.includes("Security review"))
      .join("\n");
    const v = checklistViolations(body);
    expect(
      v.some((m) => m.includes("required Security review checklist line")),
    ).toBe(true);
  });

  it("does not let a reason's free text satisfy a deleted line's presence", () => {
    const body =
      "## Checklist\n\n" +
      "- [x] CHANGELOG.md [Unreleased] updated -- n/a: doc-only edit; the Docs: pages and Security review are unaffected\n";
    const v = checklistViolations(body);
    expect(v).toHaveLength(2);
    expect(v.some((m) => m.includes("required Docs checklist line"))).toBe(
      true,
    );
    expect(
      v.some((m) => m.includes("required Security review checklist line")),
    ).toBe(true);
  });

  it("flags a bare n/a with no reason", () => {
    for (const clause of ["-- n/a", "-- n/a bug fix"]) {
      const body = passingBody.replace(
        "-- n/a: none of the listed surfaces touched",
        clause,
      );
      const v = checklistViolations(body);
      expect(
        v.some((m) => m.includes("n/a without a reason")),
        clause,
      ).toBe(true);
    }
  });

  it("flags an n/a whose reason is punctuation only", () => {
    const body = passingBody.replace(
      "-- n/a: none of the listed surfaces touched",
      "-- n/a: ...",
    );
    const v = checklistViolations(body);
    expect(v.some((m) => m.includes("n/a without a reason"))).toBe(true);
  });

  it("passes an n/a that carries a reason", () => {
    const body = passingBody.replace(
      "-- updated docs/CLI.md",
      "-- n/a: internal refactor, no documented behavior changed",
    );
    expect(checklistViolations(body)).toEqual([]);
  });

  it("flags a checked box with no resolution clause", () => {
    const body = passingBody.replace(
      " -- n/a: none of the listed surfaces touched",
      "",
    );
    const v = checklistViolations(body);
    expect(v.some((m) => m.includes('checked box without a "--'))).toBe(true);
  });

  it("ignores example checklist lines inside HTML comments", () => {
    const body = passingBody.replace(
      "## Checklist\n",
      "## Checklist\n\n<!--\nExamples:\n" +
        "  - [ ] CHANGELOG.md [Unreleased] updated -- <the entry, or n/a: reason>\n" +
        "  - [x] Docs -- n/a\n-->\n",
    );
    expect(checklistViolations(body)).toEqual([]);
  });

  it("flags a body with no Checklist section", () => {
    const v = checklistViolations("## Summary\n\nDeliver the thing.\n");
    expect(v.some((m) => m.includes('no "## Checklist" section'))).toBe(true);
  });

  it("does not mistake a flag mention for the resolution separator", () => {
    const body = passingBody.replace(
      "-- n/a: bug fix, not a major feature",
      "-- added the `--event-stream` line under Added",
    );
    expect(checklistViolations(body)).toEqual([]);
  });

  // GitHub stores a body edited in the browser with CRLF endings, so this is the
  // shape most PR bodies arrive in, not an exotic one.
  it("reads a body whose lines end in CRLF or bare CR", () => {
    expect(bodyViolations(passingBody.replace(/\n/g, "\r\n"), HEAD)).toEqual(
      [],
    );
    expect(bodyViolations(passingBody.replace(/\n/g, "\r"), HEAD)).toEqual([]);
  });
});

describe("PR review attestation", () => {
  it("passes when the line attests the PR head", () => {
    expect(attestationViolations(passingBody, HEAD)).toEqual([]);
  });

  it("accepts an abbreviated sha of the PR head", () => {
    const body = passingBody.replace(HEAD, HEAD.slice(0, 7));
    expect(attestationViolations(body, HEAD)).toEqual([]);
  });

  it("accepts a sha written as a code span", () => {
    const body = passingBody.replace(HEAD, `\`${HEAD}\``);
    expect(attestationViolations(body, HEAD)).toEqual([]);
  });

  it("flags a sha that is not the PR head", () => {
    const body = passingBody.replace(HEAD, "fedcba98765");
    const v = attestationViolations(body, HEAD);
    expect(v.some((m) => m.includes("is not this PR's head"))).toBe(true);
  });

  it("flags a review line naming no sha", () => {
    const body = passingBody.replace(`of ${HEAD}`, "of the branch");
    const v = attestationViolations(body, HEAD);
    expect(v.some((m) => m.includes("names no sha"))).toBe(true);
  });

  it("flags more than one Security review line", () => {
    const line = `- [x] Security review of ${HEAD}`;
    const body = passingBody.replace(
      line,
      `${line} -- reviewed the parser\n${line}`,
    );
    const v = attestationViolations(body, HEAD);
    expect(
      v.some((m) => m.includes("more than one Security review line")),
    ).toBe(true);
  });

  it("leaves a deleted review line to the checklist check", () => {
    const body = passingBody
      .split("\n")
      .filter((line) => !line.includes("Security review"))
      .join("\n");
    expect(attestationViolations(body, HEAD)).toEqual([]);
    expect(
      bodyViolations(body, HEAD).some((m) =>
        m.includes("required Security review checklist line"),
      ),
    ).toBe(true);
  });

  it("checks only that a sha is named when the head is unknown", () => {
    const stale = passingBody.replace(HEAD, "fedcba98765");
    expect(attestationViolations(stale, null)).toEqual([]);
    const v = attestationViolations(
      passingBody.replace(`of ${HEAD}`, "of the branch"),
      null,
    );
    expect(v.some((m) => m.includes("names no sha"))).toBe(true);
  });

  // Prose naming the head reads as an attestation to a human skimming the body,
  // so the rules must read the line that makes the claim and nothing else --
  // including when the prose sits in another line's label, not its clause.
  it("is not satisfied by another line naming the head", () => {
    const docsDecoy = `- [x] Docs: pages updated; the Security review of ${HEAD} is recorded below -- updated docs/CLI.md`;
    const decoy = passingBody
      .replace(/^- \[x\] Docs:.*$/m, docsDecoy)
      .replace(`${HEAD} --`, "fedcba98765 --");
    expect(decoy).toContain(docsDecoy);
    expect(decoy).toContain("Security review of fedcba98765 --");
    const v = bodyViolations(decoy, HEAD);
    expect(v.some((m) => m.includes("is not this PR's head"))).toBe(true);

    const deleted = decoy
      .split("\n")
      .filter((line) => !line.startsWith("- [x] Security review"))
      .join("\n");
    expect(
      bodyViolations(deleted, HEAD).some((m) =>
        m.includes("required Security review checklist line"),
      ),
    ).toBe(true);
  });

  it("reads the head from the environment the workflow sets", () => {
    const saved = process.env.PR_HEAD_SHA;
    try {
      delete process.env.PR_HEAD_SHA;
      expect(prHeadSha()).toBe(null);
      process.env.PR_HEAD_SHA = HEAD;
      expect(prHeadSha()).toBe(HEAD);
      // A head that is not a readable sha is an unreadable head, not one that
      // matches nothing: the caller must stop, not compare against it.
      for (const unreadable of ["", "   "]) {
        process.env.PR_HEAD_SHA = unreadable;
        expect(prHeadSha()).toBe(null);
      }
    } finally {
      if (saved === undefined) delete process.env.PR_HEAD_SHA;
      else process.env.PR_HEAD_SHA = saved;
    }
  });
});

describe("PR title length", () => {
  it("passes a title at exactly the budget", () => {
    const { budget } = titleBudget("1274");
    expect(titleViolations("x".repeat(budget), "1274")).toEqual([]);
  });

  it("fails a title one character over the budget", () => {
    const { budget } = titleBudget("1274");
    const v = titleViolations("x".repeat(budget + 1), "1274");
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(`${budget + 1} characters`);
    expect(v[0]).toContain(`${budget}-character budget`);
  });

  it("shrinks the budget by one for a five-digit PR number", () => {
    const fourDigit = titleBudget("1274").budget;
    const fiveDigit = titleBudget("12745").budget;
    expect(fiveDigit).toBe(fourDigit - 1);
    const title = "x".repeat(fourDigit);
    expect(titleViolations(title, "1274")).toEqual([]);
    expect(titleViolations(title, "12745")).not.toEqual([]);
  });

  it("falls back to the 42-character budget with no PR number", () => {
    expect(titleBudget(undefined).budget).toBe(42);
    expect(titleBudget(null).budget).toBe(42);
    expect(titleViolations("x".repeat(42), undefined)).toEqual([]);
    expect(titleViolations("x".repeat(43), undefined)).not.toEqual([]);
  });

  it("flags an empty or whitespace-only title with its own message", () => {
    for (const title of ["", "   "]) {
      const v = titleViolations(title, "1274");
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("empty");
    }
  });
});

// The shipped template, not a fixture: a reword of a guarded line fails here
// rather than passing silently in CI with the rule reading nothing.
const template = readFileSync(
  fileURLToPath(
    new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
  ),
  "utf8",
);

// The template as an author resolves it: every box checked, every placeholder
// clause answered, and the review line attesting the head.
const resolvedTemplate = template
  .split("\n")
  .map((line) =>
    line.startsWith("- [ ] ")
      ? line
          .replace("- [ ] ", "- [x] ")
          .replace("<sha>", HEAD)
          .replace(/<[^<>]*>$/, "resolved for this fixture")
      : line,
  )
  .join("\n");

describe("the shipped PR template", () => {
  it("fails while its boxes are unchecked and its sha unwritten", () => {
    const v = bodyViolations(template, HEAD);
    expect(v.filter((m) => m.includes("unchecked box"))).toHaveLength(3);
    expect(v.some((m) => m.includes("names no sha"))).toBe(true);
  });

  it("passes once resolved, so its spelling still answers every rule", () => {
    expect(resolvedTemplate).toContain(`Security review of ${HEAD}`);
    expect(bodyViolations(resolvedTemplate, HEAD)).toEqual([]);
  });
});

describe("the comment stripper", () => {
  it("blanks a comment while preserving line numbers", () => {
    expect(stripHtmlComments("a\n<!-- one\ntwo -->\nb")).toBe("a\n\n\nb");
  });

  it("blanks adjacent comments and leaves the text between them", () => {
    expect(stripHtmlComments("<!--a--><!--b--> tail")).toBe(" tail");
  });

  it("treats an unterminated comment as commenting out the rest", () => {
    expect(stripHtmlComments("a\n<!-- open\n- [ ] example\n")).toBe("a\n\n\n");
  });

  it("leaves a closer that opens nothing alone", () => {
    expect(stripHtmlComments("text --> more")).toBe("text --> more");
  });
});

const SCRIPT = fileURLToPath(
  new URL("./check-pr-checklist.mjs", import.meta.url),
);

// The script as the workflow runs it: a real subprocess with a controlled
// environment, so the exit codes and the runner's head resolution are exercised
// rather than assumed.
function runCli(bodyText, env) {
  const dir = mkdtempSync(join(tmpdir(), "pr-body-"));
  const file = join(dir, "body.md");
  writeFileSync(file, bodyText);
  try {
    execFileSync(process.execPath, [SCRIPT, file], { encoding: "utf8", env });
    return { status: 0, stderr: "" };
  } catch (error) {
    return { status: error.status, stderr: error.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A title well within the fallback and the four-digit budgets alike, for
// subprocess runs that are not themselves exercising the title-length rule.
const SHORT_TITLE = "Fix key rotation after failed exchange";

describe("the check as the workflow runs it", () => {
  it("passes a resolved body attesting the head", () => {
    const r = runCli(passingBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: HEAD,
      PR_TITLE: SHORT_TITLE,
      PR_NUMBER: "1274",
    });
    expect(r.status).toBe(0);
  });

  it("fails a body whose attested sha is not the head", () => {
    const r = runCli(passingBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: "fedcba9876543210fedcba9876543210fedcba98",
      PR_TITLE: SHORT_TITLE,
      PR_NUMBER: "1274",
    });
    expect(r.status).toBe(1);
  });

  it("refuses to pass on a runner whose head it cannot read", () => {
    const r = runCli(passingBody, { GITHUB_ACTIONS: "true" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could not read the head sha");
  });

  it("checks presence only off the runner, where there is no head", () => {
    const r = runCli(passingBody.replace(HEAD, "fedcba98765"), {});
    expect(r.status).toBe(0);
  });
});

describe("the title-length rule as the workflow runs it", () => {
  it("refuses to pass on a runner whose title it cannot read", () => {
    const r = runCli(passingBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: HEAD,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could not read the PR title");
  });

  it("does not fail a long title off the runner", () => {
    const r = runCli(passingBody, {
      PR_HEAD_SHA: HEAD,
      PR_TITLE: "x".repeat(100),
    });
    expect(r.status).toBe(0);
  });

  it("refuses to pass on a runner whose PR number it cannot read", () => {
    const r = runCli(passingBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: HEAD,
      PR_TITLE: SHORT_TITLE,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could not read the PR number");
  });

  it("labels a title violation as the PR title, not the body source", () => {
    const r = runCli(passingBody, {
      GITHUB_ACTIONS: "true",
      PR_BODY: passingBody,
      PR_HEAD_SHA: HEAD,
      PR_TITLE: "x".repeat(43),
      PR_NUMBER: "1274",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PR title: PR title is 43 characters");
    expect(r.stderr).not.toContain("PR body: PR title is");
  });
});
