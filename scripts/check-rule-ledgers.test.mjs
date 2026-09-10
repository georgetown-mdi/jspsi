import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_MD,
  FRONT_DOORS,
  LEDGER,
  claimedHooks,
  headings,
  ledgerViolations,
  mentions,
} from "./check-rule-ledgers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

const readRepo = () => ({
  claudeMd: read(CLAUDE_MD),
  ledger: read(LEDGER),
  frontDoors: FRONT_DOORS.map((file) => ({ file, source: read(file) })),
});

const withFrontDoors = (parts) => ({
  frontDoors: [{ file: "a-command.md", source: `Read ${LEDGER} first.` }],
  ...parts,
});

describe("rule ledger split", () => {
  it("passes on the real ledgers and front doors", () => {
    expect(ledgerViolations(readRepo())).toEqual([]);
  });

  it("reads the ledger's own enforcement claims", () => {
    const hooks = claimedHooks(read(LEDGER));
    expect(hooks.size).toBeGreaterThan(0);
    for (const hook of hooks) expect(hook).toMatch(/\.mjs$/);
  });

  it("flags a hook claimed by both ledgers", () => {
    const problems = ledgerViolations(
      withFrontDoors({
        claudeMd: `Rule. Enforced by \`a-hook.mjs\` on Bash.\n\n${LEDGER}\n`,
        ledger: "Rule. Enforced by `a-hook.mjs` on Bash.\n",
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a-hook.mjs");
    expect(problems[0]).toContain("belong to one ledger");
  });

  it("flags a heading text present in both ledgers", () => {
    const problems = ledgerViolations(
      withFrontDoors({
        claudeMd: `## Review flow\n\nA rule.\n\n${LEDGER}\n`,
        ledger: "### Review flow\n\nAnother rule.\n",
      }),
    );
    expect(problems).toEqual([expect.stringContaining('"Review flow"')]);
  });

  it("flags a CLAUDE.md that no longer points at the ledger", () => {
    const problems = ledgerViolations(
      withFrontDoors({
        claudeMd: "## Rules\n\nA rule.\n",
        ledger: "A rule.\n",
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("Restore the pointer bullet"),
    ]);
  });

  it("flags a second mention of the ledger in CLAUDE.md", () => {
    const problems = ledgerViolations(
      withFrontDoors({
        claudeMd: `Read ${LEDGER}. See also ${LEDGER}.\n`,
        ledger: "A rule.\n",
      }),
    );
    expect(problems).toEqual([expect.stringContaining("names")]);
    expect(problems[0]).toContain("2 times");
  });

  it("flags a front door that does not load the ledger", () => {
    const problems = ledgerViolations({
      claudeMd: `Read ${LEDGER}.\n`,
      ledger: "A rule.\n",
      frontDoors: [{ file: "a-command.md", source: "## Input\n" }],
    });
    expect(problems).toEqual([expect.stringContaining("a-command.md")]);
    expect(problems[0]).toContain("First");
  });

  it("takes only ## and ### headings, trimmed", () => {
    expect(
      headings("# Title\n## Two \n### Three\n#### Four\nnot a heading"),
    ).toEqual(["Two", "Three"]);
  });

  it("counts every mention of a path", () => {
    expect(mentions("a b a", "a")).toBe(2);
    expect(mentions("b", "a")).toBe(0);
  });

  it("names five front doors, each a file that exists", () => {
    expect(FRONT_DOORS).toHaveLength(5);
    for (const file of FRONT_DOORS) {
      expect(read(file).length, file).toBeGreaterThan(0);
    }
  });
});
