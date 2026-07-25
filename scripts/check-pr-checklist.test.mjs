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
  claimsViolations,
  CLAIMS_PLACEHOLDERS,
  prHeadSha,
  stripHtmlComments,
} from "./check-pr-checklist.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

// A minimal resolved body in the template's shape: every required line present,
// checked, carrying a resolution clause, and attesting the head it reviewed.
const passingBody = `## Summary

Deliver the thing.

## Checklist

- [x] Docs: enumerated \`docs/\` and \`docs/spec/\` and updated affected pages (\`/docs\` high level + design; \`/docs/spec\` low level + details) -- updated docs/CLI.md
- [x] \`CHANGELOG.md\` \`[Unreleased]\` updated -- n/a: bug fix, not a major feature
- [x] Security review of \`${HEAD}\` -- n/a: none of the listed surfaces touched
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
      "- [x] `CHANGELOG.md` `[Unreleased]` updated -- n/a: doc-only edit; the Docs: pages and Security review are unaffected\n";
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
    const body = passingBody.replace(
      "-- n/a: none of the listed surfaces touched",
      "-- n/a",
    );
    const v = checklistViolations(body);
    expect(v.some((m) => m.includes("n/a without a reason"))).toBe(true);
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

  it("flags a second Checklist section, whose lines go unread", () => {
    const body = `${passingBody}\n## Checklist\n\n- [ ] Docs: -- <which pages>\n`;
    const v = checklistViolations(body);
    expect(v.some((m) => m.includes('duplicate "## Checklist" section'))).toBe(
      true,
    );
  });

  // GitHub stores a body edited in the browser with CRLF endings, so this is the
  // shape most PR bodies arrive in, not an exotic one.
  it("reads a body stored with CRLF endings", () => {
    expect(checklistViolations(passingBody.replace(/\n/g, "\r\n"))).toEqual([]);
    expect(checklistViolations(passingBody.replace(/\n/g, "\r"))).toEqual([]);
  });

  it("does not mistake a flag mention for the resolution separator", () => {
    const body = passingBody.replace(
      "-- n/a: bug fix, not a major feature",
      "-- added the `--event-stream` line under Added",
    );
    expect(checklistViolations(body)).toEqual([]);
  });

  it("strips comments while preserving line numbers", () => {
    const stripped = stripHtmlComments("a\n<!-- one\ntwo -->\nb");
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toContain("one");
  });

  it("treats an unterminated comment as commenting out the rest", () => {
    const stripped = stripHtmlComments("a\n<!-- open\n- [ ] example\n");
    expect(stripped).not.toContain("example");
  });
});

// The shipped template, not a fixture: a reword that escapes a rule fails here
// rather than passing silently in CI.
const template = readFileSync(
  fileURLToPath(
    new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
  ),
  "utf8",
);

const claimsSection = `## Claims to refute

- "bounded by the max reconnect attempts" -- the counter is compared in reconnect(), covered by adapter.test.ts
`;

// The section followed by another heading, so the section-bounds scan is exercised
// rather than reading to the end of the body.
const claimsBody = `${claimsSection}\n## Background\n\nContext.\n`;

describe("PR claims guard", () => {
  it("passes an enumerated claim carrying what enforces it", () => {
    expect(claimsViolations(claimsBody)).toEqual([]);
  });

  it("passes a none that carries a reason", () => {
    const body = claimsBody.replace(
      /- "bounded.*/,
      "none -- doc-only edit, no behavior asserted",
    );
    expect(claimsViolations(body)).toEqual([]);
  });

  it("flags a missing section", () => {
    const v = claimsViolations("## Summary\n\nDeliver the thing.\n");
    expect(v.some((m) => m.includes('no "## Claims to refute" section'))).toBe(
      true,
    );
  });

  it("flags a second Claims section, whose lines go unread", () => {
    const v = claimsViolations(`${claimsBody}\n${claimsSection}`);
    expect(
      v.some((m) => m.includes('duplicate "## Claims to refute" section')),
    ).toBe(true);
  });

  it("flags a prefilled template left below a resolved body", () => {
    const resolved = `${claimsSection}\n${passingBody}`;
    const v = bodyViolations(`${resolved}\n${template}`, HEAD);
    expect(v.some((m) => m.includes('duplicate "## Checklist" section'))).toBe(
      true,
    );
    expect(
      v.some((m) => m.includes('duplicate "## Claims to refute" section')),
    ).toBe(true);
  });

  it("flags a section whose only content is guidance comments", () => {
    const body =
      "## Claims to refute\n\n<!-- - <claim> -- <what enforces it> -->\n\n## Background\n";
    const v = claimsViolations(body);
    expect(
      v.some((m) => m.includes('empty "## Claims to refute" section')),
    ).toBe(true);
  });

  it("flags a bare none", () => {
    for (const none of ["none", "- none", "none.", "None:"]) {
      const body = claimsBody.replace(/- "bounded.*/, none);
      const v = claimsViolations(body);
      expect(v.some((m) => m.includes('bare "none"'))).toBe(true);
    }
  });

  it("flags a bare none wearing markdown emphasis", () => {
    for (const none of [
      "**none**",
      "*none*",
      "_none_",
      "__none__",
      "`none`",
      "~~none~~",
      "- **None.**",
    ]) {
      const body = claimsBody.replace(/- "bounded.*/, none);
      const v = claimsViolations(body);
      expect(v.some((m) => m.includes('bare "none"'))).toBe(true);
    }
  });

  it("passes an emphasized none that carries a reason", () => {
    const body = claimsBody.replace(
      /- "bounded.*/,
      "**none** -- doc-only edit, no behavior asserted",
    );
    expect(claimsViolations(body)).toEqual([]);
  });

  it("does not mistake a claim that begins with none for a bare none", () => {
    const body = claimsBody.replace(
      /- "bounded.*/,
      '- "none of the retries are unbounded" -- the loop bound is asserted in retry.test.ts',
    );
    expect(claimsViolations(body)).toEqual([]);
  });

  it("flags an unfilled template placeholder", () => {
    const body = claimsBody.replace(
      /- "bounded.*/,
      "- <claim, quoted from this description> -- <the line, test, or check that enforces it>",
    );
    const v = claimsViolations(body);
    expect(v.some((m) => m.includes("unfilled placeholder"))).toBe(true);
  });

  it("flags every placeholder the shipped template carries", () => {
    expect(CLAIMS_PLACEHOLDERS.length).toBeGreaterThan(0);
    for (const placeholder of CLAIMS_PLACEHOLDERS) {
      expect(template).toContain(placeholder);
      const body = claimsBody.replace(
        /- "bounded.*/,
        `- "the claim" -- ${placeholder}`,
      );
      const v = claimsViolations(body);
      expect(v.some((m) => m.includes("unfilled placeholder"))).toBe(true);
    }
  });

  it("does not mistake a quoted generic type for a placeholder", () => {
    for (const type of [
      "Array<string>",
      "Record<string, number>",
      "Map<K, V>",
      "Promise<Result<T, E>>",
    ]) {
      const body = claimsBody.replace(
        /- "bounded.*/,
        `- "parse() returns ${type} or throws" -- asserted in parse.test.ts`,
      );
      expect(claimsViolations(body)).toEqual([]);
    }
  });

  it("aggregates checklist, claims, and attestation violations", () => {
    const v = bodyViolations(passingBody, HEAD);
    expect(v.some((m) => m.includes('no "## Claims to refute" section'))).toBe(
      true,
    );
    expect(bodyViolations(`${claimsSection}\n${passingBody}`, HEAD)).toEqual(
      [],
    );
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

  it("flags a sha that is not the PR head", () => {
    const stale = "fedcba9876543210fedcba9876543210fedcba98";
    const v = attestationViolations(passingBody.replace(HEAD, stale), HEAD);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(stale);
    expect(v[0]).toContain(HEAD.slice(0, 12));
  });

  it("flags a review line naming no sha", () => {
    const body = passingBody.replace(`of \`${HEAD}\``, "");
    const v = attestationViolations(body, HEAD);
    expect(v.some((m) => m.includes("names no sha"))).toBe(true);
  });

  it("leaves a deleted review line to the checklist check", () => {
    const body = passingBody
      .split("\n")
      .filter((line) => !line.includes("Security review"))
      .join("\n");
    expect(attestationViolations(body, HEAD)).toEqual([]);
  });

  it("checks only that a sha is named when the head is unknown", () => {
    const stale = passingBody.replace(HEAD, "fedcba98765");
    for (const unknown of [null, undefined]) {
      expect(attestationViolations(stale, unknown)).toEqual([]);
      const v = attestationViolations(
        passingBody.replace(HEAD, "the head"),
        unknown,
      );
      expect(v.some((m) => m.includes("names no sha"))).toBe(true);
    }
  });

  it("reads the head from the workflow event payload", () => {
    const saved = [process.env.PR_HEAD_SHA, process.env.GITHUB_EVENT_PATH];
    const dir = mkdtempSync(join(tmpdir(), "pr-head-"));
    const payload = join(dir, "event.json");
    writeFileSync(
      payload,
      JSON.stringify({ pull_request: { head: { sha: HEAD } } }),
    );
    try {
      delete process.env.PR_HEAD_SHA;
      delete process.env.GITHUB_EVENT_PATH;
      expect(prHeadSha()).toBe(null);
      process.env.GITHUB_EVENT_PATH = payload;
      expect(prHeadSha()).toBe(HEAD);
      process.env.PR_HEAD_SHA = "abc1234";
      expect(prHeadSha()).toBe("abc1234");
    } finally {
      const [head, event] = saved;
      if (head === undefined) delete process.env.PR_HEAD_SHA;
      else process.env.PR_HEAD_SHA = head;
      if (event === undefined) delete process.env.GITHUB_EVENT_PATH;
      else process.env.GITHUB_EVENT_PATH = event;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the shipped PR template", () => {
  it("fails the claims check while its placeholder is unfilled", () => {
    const v = claimsViolations(template);
    expect(v.some((m) => m.includes("unfilled placeholder"))).toBe(true);
  });

  it("fails the attestation check while its sha is unfilled", () => {
    const v = attestationViolations(template, HEAD);
    expect(v.some((m) => m.includes("names no sha"))).toBe(true);
  });

  it("never passes unresolved", () => {
    expect(bodyViolations(template, HEAD).length).toBeGreaterThan(0);
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

describe("the check as the workflow runs it", () => {
  const resolvedBody = `${claimsSection}\n${passingBody}`;

  it("passes a resolved body attesting the head", () => {
    const r = runCli(resolvedBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: HEAD,
    });
    expect(r.status).toBe(0);
  });

  it("fails a body attesting anything else", () => {
    const r = runCli(resolvedBody, {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: "f".repeat(40),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not this PR's head");
  });

  it("refuses to pass on a runner whose head it cannot read", () => {
    const r = runCli(resolvedBody, { GITHUB_ACTIONS: "true" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("could not read the head sha");
  });

  it("passes a body stored with CRLF endings", () => {
    const r = runCli(resolvedBody.replace(/\n/g, "\r\n"), {
      GITHUB_ACTIONS: "true",
      PR_HEAD_SHA: HEAD,
    });
    expect(r.status).toBe(0);
  });
});
