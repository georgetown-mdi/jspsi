import { expect, test } from "vitest";
import type { getLogger, LinkageTerms } from "@psilink/core";

import { checkLinkageSatisfiability } from "../../src/commands/linkagePreflight";

// Minimal logger stub: checkLinkageSatisfiability only emits warnings (the block
// path throws), so capture log.warn. Cast through unknown because the parameter
// is the full loglevel logger type but only `warn` is exercised here.
function makeLogger(): { log: ReturnType<typeof getLogger>; warns: string[] } {
  const warns: string[] = [];
  const log = {
    warn: (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    },
  } as unknown as ReturnType<typeof getLogger>;
  return { log, warns };
}

const messaging = {
  source: "invitation",
  blockRemedy: "request a fresh invitation.",
};

// A single date_of_birth field bound to a present "dob" column, so the key is
// always shape-satisfiable; the element transform decides whether it is dead.
function dobTerms(
  transform?: { function: string; params?: Record<string, unknown> }[],
): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "dob", type: "date_of_birth" }],
    linkageKeys: [
      {
        name: "DOB",
        elements: [{ field: "dob", ...(transform && { transform }) }],
      },
    ],
  };
}

test("warns by name when a linkage key's parse_date drops every record", () => {
  const { log, warns } = makeLogger();
  // The column is present, so the column verdict passes (no block, no
  // unsatisfied-field warn); the only warning is the dead-key one.
  expect(() =>
    checkLinkageSatisfiability(
      ["dob"],
      dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
      log,
      messaging,
    ),
  ).not.toThrow();
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("can never match");
  expect(warns[0]).toContain("(DOB)");
  expect(warns[0]).toContain("invitation");
});

test("does not warn for a complete parse_date input format", () => {
  const { log, warns } = makeLogger();
  checkLinkageSatisfiability(
    ["dob"],
    dobTerms([
      { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
    ]),
    log,
    messaging,
  );
  expect(warns).toEqual([]);
});

test("a dead key and a column-unsatisfiable key both warn (independent signals)", () => {
  const { log, warns } = makeLogger();
  // DOB is shape-satisfiable (column present) but dead; SSN is shape-unsatisfiable
  // (no ssn column). The dead-key warning and the partial-coverage warning are
  // distinct signals and both fire; the run is not blocked (one key is countable).
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "DOB",
        elements: [
          {
            field: "dob",
            transform: [
              { function: "parse_date", params: { inputFormat: "MM/DD" } },
            ],
          },
        ],
      },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
  expect(() =>
    checkLinkageSatisfiability(["dob"], terms, log, messaging),
  ).not.toThrow();
  expect(warns.some((w) => w.includes("can never match"))).toBe(true);
  expect(warns.some((w) => w.includes("cannot satisfy all"))).toBe(true);
});

test("a key blocked for a missing column is not also warned as dead, and still throws", () => {
  const { log, warns } = makeLogger();
  // The column is absent, so the key fails the column verdict (block); a dead
  // element transform does not produce a second, contradictory dead-key warning,
  // since deadKeys is scoped to shape-satisfiable keys.
  expect(() =>
    checkLinkageSatisfiability(
      ["other_column"],
      dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
      log,
      messaging,
    ),
  ).toThrow("cannot satisfy any");
  expect(warns).toEqual([]);
});
