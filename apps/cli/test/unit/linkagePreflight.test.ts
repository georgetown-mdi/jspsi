import { expect, test } from "vitest";
import {
  CAUSE_DEPTH_ELISION_MARKER,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  inferMetadata,
  MAX_ERROR_CAUSE_DEPTH,
  MAX_NAME_LENGTH,
  sanitizeErrorForDisplay,
  UsageError,
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

function refusalRenderedForDisplay(
  columns: string[],
  terms: LinkageTerms,
  log: ReturnType<typeof getLogger>,
): string {
  let thrown: unknown;
  try {
    checkLinkageSatisfiability(columns, terms, log, messaging);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  // The refusal composes its tokens RAW, so the escape it relies on is the one
  // the CLI's error boundary applies (`sanitizeErrorForDisplay` in `runOrExit`
  // and `exitWithError`). Reading `.message` would measure a different string
  // than the operator sees; render it the way the boundary does.
  return sanitizeErrorForDisplay(thrown);
}

// The rendered refusal split into the cause links the operator reads, in order.
function refusalLinks(
  columns: string[],
  terms: LinkageTerms,
  log: ReturnType<typeof getLogger>,
): string[] {
  return refusalRenderedForDisplay(columns, terms, log).split("\ncaused by: ");
}

test("refuses by name when the only linkage key's parse_date drops every record", () => {
  const { log, warns } = makeLogger();
  // The column is present, so the column verdict passes -- yet the one key it
  // satisfies is dead, so the run could emit no key string and would write a
  // guaranteed-empty result at exit 0. It is refused instead, naming the key on a
  // link of its own behind the terms-side remedy.
  const links = refusalLinks(
    ["dob"],
    dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
    log,
  );
  expect(links[0]).toContain(
    "none of the invitation's linkage keys can ever match",
  );
  expect(links[1]).toBe(
    `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("linkage key that drops every record: DOB");
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
  const links = refusalLinks(["dob"], terms, log);
  expect(links[0]).toContain("the CSV satisfies no other key");
  expect(links[1]).toBe(
    `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("linkage key that drops every record: DOB");
  expect(links).toContain("unsatisfied field: ssn (ssn)");
  expect(warns).toEqual([]);
});

// linkageKeys is bounded only at MAX_LINKAGE_ENTRIES, so the dead-key
// enumeration can ask for more cause links than the renderer walks, exactly as
// the column block's field enumeration can. The remedy must still arrive whole,
// and the keys past the depth bound must be counted rather than dropped into a
// list that reads as complete.
test("the dead-key refusal reports the keys it could not name, with the total", () => {
  const { log } = makeLogger();
  const total = 20;
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageKeys: Array.from({ length: total }, (_, index) => ({
      name: `KEY_${index}`,
      elements: [
        {
          field: "dob",
          transform: [
            { function: "parse_date", params: { inputFormat: "MM/DD" } },
          ],
        },
      ],
    })),
  };
  const links = refusalLinks(["dob"], terms, log);

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links[0]).toContain(
    "none of the invitation's linkage keys can ever match",
  );
  expect(links[1]).toBe(
    `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );

  const named = links.slice(2, -1);
  expect(named.length).toBeGreaterThan(0);
  named.forEach((link, index) =>
    expect(link).toBe(`linkage key that drops every record: KEY_${index}`),
  );
  expect(links[links.length - 1]).toBe(
    `and ${total - named.length} more details of the keys that cannot match ` +
      `(${total} in total)`,
  );

  const rendered = links.join("\n");
  for (let index = named.length; index < total; index++)
    expect(rendered).not.toContain(`record: KEY_${index}`);
  // The composition fits the depth bound, so the renderer's generic marker --
  // which cannot report a count -- never has to stand in for it.
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

// --- escaping ----------------------------------------------------------------

// A partner-authored name carrying the two bytes the escape exists for: a literal
// backslash, which every sanitizing pass doubles (so a second pass is visible in
// the output), and an ESC, which opens an ANSI sequence on a terminal. Key names
// come from the invitation on the accept path and field names from its terms, so
// both are partner-controlled.
const ESC = "\u001b";
const HOSTILE_KEY_NAME = `DOB\\evil${ESC}[31m`;
const HOSTILE_KEY_ESCAPED_ONCE = String.raw`DOB\\evil\x1b[31m`;
const HOSTILE_KEY_ESCAPED_TWICE = String.raw`DOB\\\\evil\\x1b[31m`;
const HOSTILE_FIELD_NAME = `ssn\\evil${ESC}[31m`;
const HOSTILE_FIELD_ESCAPED_ONCE = String.raw`ssn\\evil\x1b[31m`;
const HOSTILE_FIELD_ESCAPED_TWICE = String.raw`ssn\\\\evil\\x1b[31m`;

const deadDobElement = {
  field: "dob",
  transform: [{ function: "parse_date", params: { inputFormat: "MM/DD" } }],
};

// The only key is dead and hostile-named: the all-keys-dead refusal, naming it.
function hostileDeadKeyTerms(): LinkageTerms {
  return {
    ...dobTerms(),
    linkageKeys: [{ name: HOSTILE_KEY_NAME, elements: [deadDobElement] }],
  };
}

// The only key needs a hostile-named field no column satisfies: the column
// refusal, whose detail names the field.
function hostileUnsatisfiedFieldTerms(): LinkageTerms {
  return {
    ...dobTerms(),
    linkageFields: [{ name: HOSTILE_FIELD_NAME, type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: HOSTILE_FIELD_NAME }] }],
  };
}

// A hostile-named dead key, a live key, and a key needing a hostile-named field
// the CSV lacks: one call that reaches both warn routes, neither refused.
function hostileWarnedTerms(): LinkageTerms {
  return {
    ...dobTerms(),
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
      { name: HOSTILE_FIELD_NAME, type: "email_address" },
    ],
    linkageKeys: [
      { name: HOSTILE_KEY_NAME, elements: [deadDobElement] },
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "EMAIL", elements: [{ field: HOSTILE_FIELD_NAME }] },
    ],
  };
}

test("a refusal escapes a hostile key or field name exactly once end to end", () => {
  const { log, warns } = makeLogger();

  const deadKeyRefusal = refusalRenderedForDisplay(
    ["dob"],
    hostileDeadKeyTerms(),
    log,
  );
  expect(deadKeyRefusal).toContain(HOSTILE_KEY_ESCAPED_ONCE);
  expect(deadKeyRefusal).not.toContain(HOSTILE_KEY_ESCAPED_TWICE);
  expect(deadKeyRefusal).not.toContain(ESC);

  const columnRefusal = refusalRenderedForDisplay(
    ["dob"],
    hostileUnsatisfiedFieldTerms(),
    log,
  );
  expect(columnRefusal).toContain(HOSTILE_FIELD_ESCAPED_ONCE);
  expect(columnRefusal).not.toContain(HOSTILE_FIELD_ESCAPED_TWICE);
  expect(columnRefusal).not.toContain(ESC);

  expect(warns).toEqual([]);
});

test("a warning escapes a hostile key or field name exactly once end to end", () => {
  const { log, warns } = makeLogger();
  // The warn call site is the sink: nothing escapes downstream of it, so the
  // escaped form has to be what the sink already received.
  checkLinkageSatisfiability(
    ["dob", "ssn"],
    hostileWarnedTerms(),
    log,
    messaging,
  );

  expect(warns).toHaveLength(2);
  const [deadKeyWarning, unsatisfiedFieldWarning] = warns;
  expect(deadKeyWarning).toContain(HOSTILE_KEY_ESCAPED_ONCE);
  expect(deadKeyWarning).not.toContain(HOSTILE_KEY_ESCAPED_TWICE);
  expect(deadKeyWarning).not.toContain(ESC);
  expect(unsatisfiedFieldWarning).toContain(HOSTILE_FIELD_ESCAPED_ONCE);
  expect(unsatisfiedFieldWarning).not.toContain(HOSTILE_FIELD_ESCAPED_TWICE);
  expect(unsatisfiedFieldWarning).not.toContain(ESC);
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
