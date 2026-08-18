import { expect, test } from "vitest";
import {
  CAUSE_DEPTH_ELISION_MARKER,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  inferMetadata,
  MAX_ERROR_CAUSE_DEPTH,
  MAX_NAME_LENGTH,
  sanitizeErrorForDisplay,
} from "@psilink/core";
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

// The block names field names that are TERMS content -- the partner's, on the
// accept path -- so each sits on a labelled link of its own and can spend no
// budget but that link's. Driven at the widest name the terms schema admits, and
// at a name past every budget, because what the operator has to act on is the
// remedy behind them.
test.each([
  ["the widest name the terms schema admits", MAX_NAME_LENGTH],
  ["a name past every budget", COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH * 4],
])(
  "the block's remedy reaches the operator whole under %s",
  (_label, width) => {
    const { log } = makeLogger();
    const wide = "w".repeat(width);
    const terms: LinkageTerms = {
      ...dobTerms(),
      linkageFields: [{ name: wide, type: "ssn" }],
      linkageKeys: [{ name: "SSN", elements: [{ field: wide }] }],
    };
    const err = (() => {
      try {
        checkLinkageSatisfiability(["other_column"], terms, log, messaging);
      } catch (e: unknown) {
        return e;
      }
      throw new Error("the pre-flight did not block");
    })();

    const links = sanitizeErrorForDisplay(err).split("\ncaused by: ");
    expect(links[0]).toContain("cannot satisfy any of the invitation's");
    // The remedy whole, not a prefix of it: a wide name sharing its link is what
    // would deliver one.
    expect(links).toContain(
      `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
    );
    const nameLink = links.find((link) =>
      link.startsWith("unsatisfied field: "),
    );
    expect(nameLink).toBeDefined();
    expect(nameLink).toContain("w".repeat(64));
  },
);

// Terms whose every declared field is unsatisfiable against a CSV holding none
// of them, one key per field, so no key is countable and the pre-flight blocks
// with `fieldCount` names to enumerate.
function unsatisfiableTerms(fieldCount: number): LinkageTerms {
  const fields = Array.from({ length: fieldCount }, (_, index) => ({
    name: `field${index}`,
    type: "ssn" as const,
  }));
  return {
    ...dobTerms(),
    linkageFields: fields,
    linkageKeys: fields.map((field) => ({
      name: `KEY_${field.name}`,
      elements: [{ field: field.name }],
    })),
  };
}

// Render the block this terms set raises, as the operator reads it.
function blockedLinks(terms: LinkageTerms): string[] {
  const { log } = makeLogger();
  const err = (() => {
    try {
      checkLinkageSatisfiability(["other_column"], terms, log, messaging);
    } catch (e: unknown) {
      return e;
    }
    throw new Error("the pre-flight did not block");
  })();
  return sanitizeErrorForDisplay(err).split("\ncaused by: ");
}

// linkageFields is bounded only at MAX_LINKAGE_ENTRIES, so the enumeration can
// ask for more cause links than the renderer walks. What the operator must not
// get is a list that reads as complete while the rest was dropped past the depth
// bound, so the last link the renderer reaches reports the overflow and the
// total instead of naming one more field.
test("the block reports the fields it could not name, with the total", () => {
  const total = 20;
  const links = blockedLinks(unsatisfiableTerms(total));

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links[0]).toContain("cannot satisfy any of the invitation's");
  expect(links[1]).toBe(
    `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
  );

  const named = links.slice(2, -1);
  expect(named.length).toBeGreaterThan(0);
  named.forEach((link, index) =>
    expect(link).toBe(`unsatisfied field: field${index} (ssn)`),
  );
  expect(links[links.length - 1]).toBe(
    `and ${total - named.length} more unsatisfied fields (${total} in total)`,
  );

  // The fields past the enumeration are accounted for by that count, not by a
  // name the operator would search the output for.
  const rendered = links.join("\n");
  for (let index = named.length; index < total; index++)
    expect(rendered).not.toContain(`field${index} (ssn)`);
  // The composition fits the depth bound, so the renderer's generic marker --
  // which cannot report a count -- never has to stand in for it.
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

test("the block names every field when they all fit the link budget", () => {
  // One name per link the renderer reaches after the summary and the remedy: the
  // widest enumeration that needs no overflow link at all.
  const total = MAX_ERROR_CAUSE_DEPTH - 2;
  const links = blockedLinks(unsatisfiableTerms(total));

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links.slice(2)).toEqual(
    Array.from(
      { length: total },
      (_, index) => `unsatisfied field: field${index} (ssn)`,
    ),
  );
  const rendered = links.join("\n");
  expect(rendered).not.toContain("more unsatisfied fields");
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});
