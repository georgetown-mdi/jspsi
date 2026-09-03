import { expect, test } from "vitest";
import {
  CAUSE_DEPTH_ELISION_MARKER,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  inferMetadata,
  LinkageTermsUnsatisfiableError,
  MAX_ERROR_CAUSE_DEPTH,
  MAX_NAME_LENGTH,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type { getLogger, LinkageTerms } from "@psilink/core";

import {
  checkLinkageSatisfiability,
  RUN_BLOCK_CONSEQUENCE,
  warnColumnsTheInvitationWillNotAccept,
} from "../../src/commands/linkagePreflight";

// Minimal logger stub for warnColumnsTheInvitationWillNotAccept, the one export
// here that still writes to a log sink. Cast through unknown because the
// parameter is the full loglevel logger type but only `warn` is exercised.
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
  blockConsequence: RUN_BLOCK_CONSEQUENCE,
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

const deadDobElement = {
  field: "dob",
  transform: [{ function: "parse_date", params: { inputFormat: "MM/DD" } }],
};

function refusalRenderedForDisplay(
  columns: string[],
  terms: LinkageTerms,
): string {
  let thrown: unknown;
  try {
    checkLinkageSatisfiability(columns, terms, messaging);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
  expect(thrown).toBeInstanceOf(UsageError);
  // The refusal composes its tokens RAW, so the escape it relies on is the one
  // the CLI's error boundary applies (`sanitizeErrorForDisplay` in `runOrExit`
  // and `exitWithError`). Reading `.message` would measure a different string
  // than the operator sees; render it the way the boundary does.
  return sanitizeErrorForDisplay(thrown);
}

// The rendered refusal split into the cause links the operator reads, in order.
function refusalLinks(columns: string[], terms: LinkageTerms): string[] {
  return refusalRenderedForDisplay(columns, terms).split("\ncaused by: ");
}

test("an input satisfying every declared key passes", () => {
  expect(() =>
    checkLinkageSatisfiability(
      ["dob"],
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
      ]),
      messaging,
    ),
  ).not.toThrow();
});

test("refuses by name when the only linkage key's parse_date drops every record", () => {
  // The column is present, so the column verdict passes -- yet the one key it
  // satisfies is dead, so the run could emit no key string and would write a
  // guaranteed-empty result at exit 0. It is refused instead, naming the key on a
  // link of its own behind the terms-side remedy.
  const links = refusalLinks(
    ["dob"],
    dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
  );
  expect(links[0]).toContain(
    "cannot satisfy every linkage key the invitation declares",
  );
  expect(links[0]).toContain(
    "the cleaning declared for the one agreed linkage key drops every record",
  );
  expect(links[1]).toBe(
    `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("linkage key that drops every record: DOB");
});

test("a dead key beside a live one is refused, not warned", () => {
  // DOB is dead; SSN is satisfiable and live. The exchange would still match on
  // SSN, and would run one key short of what both parties agreed to, so it is
  // refused rather than warned about.
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      { name: "DOB", elements: [deadDobElement] },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
  const links = refusalLinks(["dob", "ssn"], terms);
  expect(links[0]).toContain(
    "the cleaning declared for 1 of the 2 agreed linkage keys drops every " +
      "record",
  );
  expect(links[1]).toBe(
    `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("linkage key that drops every record: DOB");
});

test("an input satisfying only some of the declared keys is refused", () => {
  // SSN is satisfiable; EMAIL needs a column the CSV lacks. The partial-coverage
  // case: refused, naming the field the CSV cannot produce and the key it costs.
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "email", type: "email_address" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "EMAIL", elements: [{ field: "email" }] },
    ],
  };
  const links = refusalLinks(["ssn"], terms);
  expect(links[0]).toContain(
    "1 of the 2 agreed linkage keys cannot be produced from this input's " +
      "columns",
  );
  expect(links[1]).toBe(
    `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("unsatisfied field: email (email_address)");
  expect(links).toContain("linkage key the CSV cannot produce: EMAIL");
});

test("a dead key beside a column-unsatisfiable one is refused, naming both causes", () => {
  // DOB is shape-satisfiable (column present) but dead; SSN is shape-unsatisfiable
  // (no ssn column). Every key is out, each for its own reason, so the refusal
  // states both and its remedy names both steps.
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      { name: "DOB", elements: [deadDobElement] },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
  const links = refusalLinks(["dob"], terms);
  expect(links[0]).toContain(
    "1 of the 2 agreed linkage keys cannot be produced from this input's " +
      "columns",
  );
  expect(links[0]).toContain(
    "the cleaning declared for 1 of the 2 agreed linkage keys drops every " +
      "record",
  );
  expect(links[1]).toBe(
    "Provide a CSV that covers the required field types and correct the " +
      `cleaning steps those keys declare, ${messaging.blockRemedy}`,
  );
  expect(links).toContain("linkage key that drops every record: DOB");
  expect(links).toContain("unsatisfied field: ssn (ssn)");
});

test("terms declaring no linkage key at all are refused", () => {
  // A key-count threshold passes this vacuously; the terms derivation reaches it
  // by narrowing the built-in rule set all the way down.
  const links = refusalLinks(["dob"], { ...dobTerms(), linkageKeys: [] });
  expect(links[0]).toContain(
    "the invitation's linkage terms declare no linkage key",
  );
  expect(links[1]).toBe(
    `Agree linkage terms declaring at least one linkage key, ${messaging.blockRemedy}`,
  );
});

// linkageKeys is bounded only at MAX_LINKAGE_ENTRIES, so the dead-key
// enumeration can ask for more cause links than the renderer walks, exactly as
// the field enumeration can. The remedy must still arrive whole, and the keys
// past the depth bound must be counted rather than dropped into a list that
// reads as complete.
test("the dead-key refusal reports the keys it could not name, with the total", () => {
  const total = 20;
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageKeys: Array.from({ length: total }, (_, index) => ({
      name: `KEY_${index}`,
      elements: [deadDobElement],
    })),
  };
  const links = refusalLinks(["dob"], terms);

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links[0]).toContain(
    `the cleaning declared for all ${total} agreed linkage keys drops every ` +
      "record",
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
    `and ${total - named.length} more details of the terms this CSV cannot ` +
      `satisfy (${total} in total)`,
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

// The only key is dead and hostile-named: the dead-key refusal, naming it.
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

test("a refusal escapes a hostile key or field name exactly once end to end", () => {
  const deadKeyRefusal = refusalRenderedForDisplay(
    ["dob"],
    hostileDeadKeyTerms(),
  );
  expect(deadKeyRefusal).toContain(HOSTILE_KEY_ESCAPED_ONCE);
  expect(deadKeyRefusal).not.toContain(HOSTILE_KEY_ESCAPED_TWICE);
  expect(deadKeyRefusal).not.toContain(ESC);

  const columnRefusal = refusalRenderedForDisplay(
    ["dob"],
    hostileUnsatisfiedFieldTerms(),
  );
  expect(columnRefusal).toContain(HOSTILE_FIELD_ESCAPED_ONCE);
  expect(columnRefusal).not.toContain(HOSTILE_FIELD_ESCAPED_TWICE);
  expect(columnRefusal).not.toContain(ESC);
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

test("a key blocked for a missing column is not also reported as dead", () => {
  // The column is absent, so the key is unsatisfiable; a dead element transform
  // does not additionally list it as dead, since the dead grade is scoped to
  // shape-satisfiable keys.
  const links = refusalLinks(
    ["other_column"],
    dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
  );
  expect(links[1]).toBe(
    `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
  );
  expect(links.join("\n")).not.toContain("drops every record");
});

// The refusal names field names that are TERMS content -- the partner's, on the
// accept path -- so each sits on a labelled link of its own and can spend no
// budget but that link's. Driven at the widest name the terms schema admits, and
// at a name past every budget, because what the operator has to act on is the
// remedy behind them.
test.each([
  ["the widest name the terms schema admits", MAX_NAME_LENGTH],
  ["a name past every budget", COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH * 4],
])("the refusal's remedy reaches the operator whole under %s", (_l, width) => {
  const wide = "w".repeat(width);
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [{ name: wide, type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: wide }] }],
  };
  const links = refusalLinks(["other_column"], terms);
  expect(links[0]).toContain(
    "cannot satisfy every linkage key the invitation declares",
  );
  // The remedy whole, not a prefix of it: a wide name sharing its link is what
  // would deliver one.
  expect(links).toContain(
    `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
  );
  const nameLink = links.find((link) => link.startsWith("unsatisfied field: "));
  expect(nameLink).toBeDefined();
  expect(nameLink).toContain("w".repeat(64));
});

// Terms whose every declared field is unsatisfiable against a CSV holding none
// of them, one key per field, so every key is out and the pre-flight refuses
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

// linkageFields is bounded only at MAX_LINKAGE_ENTRIES, so the enumeration can
// ask for more cause links than the renderer walks. What the operator must not
// get is a list that reads as complete while the rest was dropped past the depth
// bound, so the last link the renderer reaches reports the overflow and the
// total instead of naming one more field.
test("the refusal reports the details it could not name, with the total", () => {
  const total = 20;
  // Each key costs one detail link and each field it needs costs another.
  const details = total * 2;
  const links = refusalLinks(["other_column"], unsatisfiableTerms(total));

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links[0]).toContain(
    "cannot satisfy every linkage key the invitation declares",
  );
  expect(links[1]).toBe(
    `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
  );

  // What truncation spends the budget on is the failing keys: they are what the
  // verdict blocks on, and a field named ahead of one would push it past the
  // depth bound.
  const named = links.slice(2, -1);
  expect(named.length).toBeGreaterThan(0);
  named.forEach((link, index) =>
    expect(link).toBe(`linkage key the CSV cannot produce: KEY_field${index}`),
  );
  expect(links[links.length - 1]).toBe(
    `and ${details - named.length} more details of the terms this CSV cannot ` +
      `satisfy (${details} in total)`,
  );

  // The entries past the enumeration are accounted for by that count, not by a
  // name the operator would search the output for.
  const rendered = links.join("\n");
  for (let index = named.length; index < total; index++)
    expect(rendered).not.toContain(`KEY_field${index}`);
  expect(rendered).not.toContain("unsatisfied field: ");
  // The composition fits the depth bound, so the renderer's generic marker --
  // which cannot report a count -- never has to stand in for it.
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

test("the refusal names every detail when they all fit the link budget", () => {
  // One detail per link the renderer reaches after the summary and the remedy:
  // the widest enumeration that needs no overflow link at all. Each field costs
  // two links (the key it collapses, then the field), so half as many fields.
  const fields = (MAX_ERROR_CAUSE_DEPTH - 2) / 2;
  const links = refusalLinks(["other_column"], unsatisfiableTerms(fields));

  expect(links.length).toBe(MAX_ERROR_CAUSE_DEPTH);
  expect(links.slice(2)).toEqual([
    ...Array.from(
      { length: fields },
      (_, index) => `linkage key the CSV cannot produce: KEY_field${index}`,
    ),
    ...Array.from(
      { length: fields },
      (_, index) => `unsatisfied field: field${index} (ssn)`,
    ),
  ]);
  const rendered = links.join("\n");
  expect(rendered).not.toContain("more details of the terms");
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

test("a declared field no linkage key references is not named", () => {
  // `unsatisfiedFields` grades every DECLARED field, so a terms document may
  // report one no key draws on. Nothing blocks on that field -- the run boundary
  // grades keys -- so naming it would hand the operator a gap they need not close
  // ahead of the one they must.
  const terms: LinkageTerms = {
    ...dobTerms(),
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "unreferenced", type: "email_address" },
    ],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  };
  const links = refusalLinks(["dob"], terms);
  expect(links).toContain("linkage key the CSV cannot produce: SSN");
  expect(links).toContain("unsatisfied field: ssn (ssn)");
  expect(links.join("\n")).not.toContain("unreferenced");
});

test("a dead key's refusal names the key and no field at all", () => {
  // A dead key is shape-satisfiable, so every field it references resolves and
  // the enumeration is the key alone: the remedy is the terms, and there is no
  // column gap to report.
  const links = refusalLinks(
    ["dob"],
    dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
  );
  expect(links.slice(2)).toEqual(["linkage key that drops every record: DOB"]);
});
