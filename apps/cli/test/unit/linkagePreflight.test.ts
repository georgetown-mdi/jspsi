import { expect, test } from "vitest";
import { inferMetadata, UsageError } from "@psilink/core";
import type { getLogger, LinkageTerms } from "@psilink/core";

import {
  checkLinkageSatisfiability,
  warnColumnsTheInvitationWillNotAccept,
} from "../../src/commands/linkagePreflight";

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
    linkageStrategy: "cascade",
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

test("refuses by name when the only linkage key's parse_date drops every record", () => {
  const { log, warns } = makeLogger();
  // The column is present, so the column verdict passes -- yet the one key it
  // satisfies is dead, so the run could emit no key string and would write a
  // guaranteed-empty result at exit 0. It is refused instead, naming the key and
  // the terms-side remedy.
  expect(() =>
    checkLinkageSatisfiability(
      ["dob"],
      dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
      log,
      messaging,
    ),
  ).toThrow(/none of the invitation's linkage keys can ever match: .*DOB/);
  expect(warns).toEqual([]);
});

test("a dead key beside a live one warns and proceeds", () => {
  const { log, warns } = makeLogger();
  // DOB is dead; SSN is satisfiable and live, so the exchange can still match on
  // it. That is the partial case: warn by name, do not refuse.
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
    checkLinkageSatisfiability(["dob", "ssn"], terms, log, messaging),
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

test("a dead key beside a column-unsatisfiable one is refused, naming both causes", () => {
  const { log, warns } = makeLogger();
  // DOB is shape-satisfiable (column present) but dead; SSN is shape-unsatisfiable
  // (no ssn column). Every key is out, each for its own reason, so the refusal
  // states both rather than warning twice and running to an empty result.
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
  let thrown: unknown;
  try {
    checkLinkageSatisfiability(["dob"], terms, log, messaging);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const message = (thrown as UsageError).message;
  expect(message).toContain("DOB");
  expect(message).toContain("the CSV satisfies no other key");
  expect(message).toContain("unsatisfied fields: ssn (ssn)");
  expect(warns).toEqual([]);
});

// --- warnColumnsTheInvitationWillNotAccept ------------------------------------

// Terms mirroring an invitation that accepts no payload column while this party
// is entitled to the result -- the one pair the warning covers.
function refusingTerms(): LinkageTerms {
  return {
    ...dobTerms(),
    output: { expectsOutput: true, shareWithPartner: true },
    payload: { send: [] },
  };
}

test("the disclosed set is resolved from the column names when no metadata is supplied", () => {
  // The helper resolves `metadata ?? inferMetadata(columnNames)` because that is
  // how `prepareForExchange` resolves it at run time; a caller holding an input's
  // columns but no metadata for them must still get the warning the run's own
  // refusal will match. Drive that argument pairing directly rather than through
  // an accept invocation, which always resolves metadata for an input it read.
  const { log, warns } = makeLogger();
  const columnNames = ["dob", "diagnosis"];
  warnColumnsTheInvitationWillNotAccept({
    metadata: undefined,
    columnNames,
    terms: refusingTerms(),
    mode: "offline",
    log,
  });
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("will accept no payload columns");
  expect(warns[0]).toContain("\n  - diagnosis");

  // Same set, same message, whichever half of the pair carries it.
  const supplied = makeLogger();
  warnColumnsTheInvitationWillNotAccept({
    metadata: inferMetadata(columnNames),
    columnNames,
    terms: refusingTerms(),
    mode: "offline",
    log: supplied.log,
  });
  expect(supplied.warns).toEqual(warns);
});

test("with neither metadata nor column names there is nothing to compare", () => {
  const { log, warns } = makeLogger();
  warnColumnsTheInvitationWillNotAccept({
    metadata: undefined,
    columnNames: undefined,
    terms: refusingTerms(),
    mode: "offline",
    log,
  });
  expect(warns).toEqual([]);
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
