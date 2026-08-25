import { describe, expect, test } from "vitest";

import {
  BARE_TERMS_VALUE_PATTERN,
  MAX_BARE_TERMS_VALUE_LENGTH,
  TERMS_VALUE_DELIMITER,
  bareTermsValue,
  compatibilityMessage,
  quoteTermsValue,
  quoteTermsValueList,
} from "../src/config/compatibilityMessage";
import { validateCompatibility } from "../src/config/linkageTerms";
import type { LinkageTerms } from "../src/config/linkageTerms";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";

// --- Reading a composed diagnostic back --------------------------------------

/**
 * Walk a composed diagnostic under the grammar `quoteTermsValue` emits: outside
 * a run every character stands for itself; inside one, a doubled delimiter is a
 * literal and a single delimiter closes the run.
 *
 * Returns the message's CLAUSE SKELETON -- each run collapsed to one placeholder
 * -- and the raw values the runs carried. The skeleton is what the assertions
 * below compare: two runs of the same diagnostic, one with a benign value and one
 * with an adversarial one, must produce the SAME skeleton, which is the precise
 * statement that no value can be shown to the operator as a clause psilink wrote.
 */
const readMessage = (
  message: string,
): { skeleton: string; values: string[] } => {
  let skeleton = "";
  const values: string[] = [];
  let index = 0;
  while (index < message.length) {
    if (message[index] !== TERMS_VALUE_DELIMITER) {
      skeleton += message[index];
      index += 1;
      continue;
    }
    index += 1;
    let value = "";
    let closed = false;
    while (index < message.length) {
      if (message[index] === TERMS_VALUE_DELIMITER) {
        if (message[index + 1] === TERMS_VALUE_DELIMITER) {
          value += TERMS_VALUE_DELIMITER;
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      value += message[index];
      index += 1;
    }
    values.push(value);
    skeleton += closed ? "<value>" : "<unterminated>";
  }
  return { skeleton, values };
};

test("the reader recovers exactly what the seam delimited", () => {
  // The assertions below are only as good as this reader, so pin it against the
  // constructor it reads: quoting is injective, and the reader inverts it.
  for (const value of [
    "",
    "plain",
    'has a " quote',
    '"leading and trailing"',
    '""',
    'ends with a quote"',
    "a, b, c",
    "] and [",
  ]) {
    const read = readMessage(`local is ${quoteTermsValue(value)}.`);
    expect(read.values).toEqual([value]);
    expect(read.skeleton).toBe("local is <value>.");
  }
});

// --- The seam's constructors -------------------------------------------------

describe("quoteTermsValue", () => {
  test("wraps the value and doubles every delimiter inside it", () => {
    expect(quoteTermsValue("MOU-001")).toBe('"MOU-001"');
    expect(quoteTermsValue('a"b')).toBe('"a""b"');
    expect(quoteTermsValue('"')).toBe('""""');
  });

  test("no value can close its own run", () => {
    // The attack the delimiting exists for: a value that, undelimited, would end
    // psilink's quoted token and open a second clause of its own.
    const hostile = 'MOU-001", partner is "MOU-666';
    const message = compatibilityMessage`legal agreement reference mismatch: local is ${quoteTermsValue("MOU-001")}, partner is ${quoteTermsValue(hostile)}`;
    const read = readMessage(message);
    expect(read.skeleton).toBe(
      "legal agreement reference mismatch: local is <value>, partner is <value>",
    );
    expect(read.values).toEqual(["MOU-001", hostile]);
  });

  test("adds only printable ASCII, so the display escape rewrites none of it", () => {
    // The delimiting composes with the single-altitude escape rather than
    // duplicating it: what this adds is passed through untouched, so a run's
    // boundaries reach the operator exactly as composed.
    for (const value of ["MOU-001", 'a"b', "a, b", "[a]"]) {
      const quoted = quoteTermsValue(value);
      expect(sanitizeForDisplay(quoted)).toBe(quoted);
    }
  });
});

describe("bareTermsValue", () => {
  test("renders a schema-shaped value undelimited", () => {
    for (const value of ["1.0.0", "psi", "psi-c", "single-pass", "2030-01-01"])
      expect(bareTermsValue(value)).toBe(value);
  });

  test("falls back to the delimited form for anything else", () => {
    // The premise "the schema constrains this field" is CHECKED on the value in
    // hand rather than assumed of the caller: validateCompatibility's signature
    // takes two LinkageTerms objects and nothing in it makes them schema-parsed.
    for (const value of [
      "",
      '1.0.0", partner is "9.9.9',
      "1.0.0, partner is 9.9.9",
      "1.0.0 9.9.9",
      "2030-01-01\x1b[31m",
      "0".repeat(MAX_BARE_TERMS_VALUE_LENGTH + 1),
    ]) {
      expect(bareTermsValue(value)).toBe(quoteTermsValue(value));
      expect(readMessage(bareTermsValue(value)).values).toEqual([value]);
    }
  });

  test("the bare shape carries nothing a clause boundary is made of", () => {
    // What licenses rendering a value bare at all. Every connective these
    // diagnostics use contains a space, the payload list is built from `,`, `[`,
    // and `]`, and a run is closed by the delimiter -- so a shape admitting none
    // of those cannot participate in the structure whatever the value is.
    for (const forbidden of [TERMS_VALUE_DELIMITER, " ", ",", "[", "]", "\n"])
      expect(BARE_TERMS_VALUE_PATTERN.test(`a${forbidden}b`)).toBe(false);
  });
});

describe("quoteTermsValueList", () => {
  test("keeps the element partition the comparison used visible", () => {
    // One column named `a,b` and two named `a` and `b` are a genuine mismatch
    // (the comparison is element-wise), and the rendering has to show that rather
    // than print the same `[a,b]` for both.
    expect(quoteTermsValueList(["a,b"])).toBe('"a,b"');
    expect(quoteTermsValueList(["a", "b"])).toBe('"a","b"');
    expect(readMessage(quoteTermsValueList(["a,b"])).values).toEqual(["a,b"]);
    expect(readMessage(quoteTermsValueList(["a", "b"])).values).toEqual([
      "a",
      "b",
    ]);
  });
});

test("a raw terms value cannot be composed into a diagnostic", () => {
  // The compile-time half of the sweep: the tagged template takes only fragments
  // the seam produced, so dropping a delimiter is a build failure rather than a
  // review catch. Both accumulators in validateCompatibility hold the same brand,
  // which is what extends this from one call to every message in the function.
  const partnerChosen: string = 'MOU-001", partner is "MOU-666';
  // @ts-expect-error a plain string is not a CompatibilityMessageFragment
  const composed = compatibilityMessage`local is ${partnerChosen}`;
  // The runtime is unaffected -- the guarantee is the type error above, and this
  // keeps the binding used so the assertion is not silently dropped.
  expect(composed).toContain("local is ");
});

// --- The swept diagnostics ---------------------------------------------------

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

const base: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};

const withAgreement = (
  terms: LinkageTerms,
  reference: string,
  purpose: string,
  expirationDate = "2030-01-01",
): LinkageTerms => ({
  ...terms,
  legalAgreement: { reference, purpose, expirationDate },
});

const withRuleSet = (
  terms: LinkageTerms,
  keySet: { name: string; version: string },
  fieldSet: { name: string; version: string },
): LinkageTerms => ({ ...terms, linkageRuleSet: { keySet, fieldSet } });

const withPayload = (
  terms: LinkageTerms,
  payload: LinkageTerms["payload"],
): LinkageTerms => ({ ...terms, payload });

const columns = (...names: string[]) => names.map((name) => ({ name }));

/** The single diagnostic a case is about, located by its opening clause. */
const only = (
  produced: readonly string[],
  marker: string,
  id: string,
): string => {
  const matched = produced.filter((message) => message.startsWith(marker));
  expect(
    matched,
    `${id}: expected exactly one diagnostic opening "${marker}"`,
  ).toHaveLength(1);
  return matched[0];
};

const errorStartingWith = (
  local: LinkageTerms,
  partner: LinkageTerms,
  marker: string,
  id: string,
): string => only(validateCompatibility(local, partner).errors, marker, id);

const warningStartingWith = (
  local: LinkageTerms,
  partner: LinkageTerms,
  marker: string,
  id: string,
): string => only(validateCompatibility(local, partner).warnings, marker, id);

/**
 * Every compatibility diagnostic that names a terms value, with the value under
 * test threaded through it. The enumeration is the acceptance criterion's "so
 * none is left out": each entry supplies a benign token the case would carry
 * anyway, and the adversarial shapes below are built AROUND that token, so a
 * benign run and a hostile run of the same entry differ in nothing but the value.
 *
 * The compile-time half of the sweep is separate and stronger -- the brand on
 * validateCompatibility's accumulators, exercised above -- so this table does not
 * carry the burden of being exhaustive on its own; it is what shows the delimiting
 * actually holds on each message an operator can be shown.
 */
interface SweptDiagnostic {
  readonly id: string;
  /** A value of the shape this diagnostic legitimately carries. */
  readonly benign: string;
  /** Produce the diagnostic with `value` in the partner-chosen position. */
  readonly compose: (value: string) => string;
  /**
   * Whether the value reaches the message byte-for-byte. False only where the
   * message names the value through another encoding of its own -- the canonical
   * encoder's JSON-quoted path -- which re-escapes before the seam sees it.
   */
  readonly verbatim?: false;
}

const SWEPT: readonly SweptDiagnostic[] = [
  {
    id: "rule set mismatch, local key set name",
    benign: "hmis-keys",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: value, version: "1.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        withRuleSet(
          base,
          { name: "other-keys", version: "2.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, local key set name",
      ),
  },
  {
    id: "rule set mismatch, partner key set name",
    benign: "hmis-keys",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "other-keys", version: "2.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        withRuleSet(
          base,
          { name: value, version: "1.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, partner key set name",
      ),
  },
  {
    id: "rule set mismatch, partner field set name",
    benign: "baseline-pii",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: "other-pii", version: "2.0.0" },
        ),
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: value, version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, partner field set name",
      ),
  },
  {
    id: "rule set mismatch, partner key set version",
    benign: "2.0.0",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        withRuleSet(
          base,
          { name: "hmis-keys", version: value },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, partner key set version",
      ),
  },
  {
    id: "legal agreement reference mismatch, local side",
    benign: "MOU-001",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, value, "Care coordination"),
        withAgreement(base, "MOU-999", "Care coordination"),
        "legal agreement reference mismatch",
        "legal agreement reference mismatch, local side",
      ),
  },
  {
    id: "legal agreement reference mismatch, partner side",
    benign: "MOU-001",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-999", "Care coordination"),
        withAgreement(base, value, "Care coordination"),
        "legal agreement reference mismatch",
        "legal agreement reference mismatch, partner side",
      ),
  },
  {
    id: "legal agreement purpose mismatch, local side",
    benign: "Care coordination",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", value),
        withAgreement(base, "MOU-001", "Program audit"),
        "legal agreement purpose mismatch",
        "legal agreement purpose mismatch, local side",
      ),
  },
  {
    id: "legal agreement purpose mismatch, partner side",
    benign: "Care coordination",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", "Program audit"),
        withAgreement(base, "MOU-001", value),
        "legal agreement purpose mismatch",
        "legal agreement purpose mismatch, partner side",
      ),
  },
  {
    id: "legal agreement expiration date mismatch, partner side",
    benign: "2031-06-30",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", "Care coordination", "2030-01-01"),
        withAgreement(base, "MOU-001", "Care coordination", value),
        "legal agreement expiration date mismatch",
        "legal agreement expiration date mismatch, partner side",
      ),
  },
  {
    id: "legal agreement expired on",
    benign: "2020-01-01",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", "Care coordination", value),
        withAgreement(base, "MOU-001", "Care coordination", value),
        "legal agreement expired on",
        "legal agreement expired on",
      ),
  },
  {
    id: "version mismatch, partner side",
    benign: "2.0.0",
    compose: (value) =>
      errorStartingWith(
        base,
        { ...base, version: value },
        "version mismatch",
        "version mismatch, partner side",
      ),
  },
  {
    id: "algorithm mismatch, partner side",
    benign: "psi-c",
    compose: (value) =>
      errorStartingWith(
        base,
        { ...base, algorithm: value as LinkageTerms["algorithm"] },
        "algorithm mismatch",
        "algorithm mismatch, partner side",
      ),
  },
  {
    id: "linkage strategy mismatch, partner side",
    benign: "single-pass",
    compose: (value) =>
      errorStartingWith(
        base,
        {
          ...base,
          linkageStrategy: value as LinkageTerms["linkageStrategy"],
        },
        "linkage strategy mismatch",
        "linkage strategy mismatch, partner side",
      ),
  },
  {
    id: "date mismatch warning, partner side",
    benign: "2025-06-01",
    compose: (value) =>
      warningStartingWith(
        base,
        { ...base, date: value },
        "date mismatch",
        "date mismatch warning, partner side",
      ),
  },
  {
    id: "payload mismatch, local send against partner receive",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { send: columns(value) }),
        withPayload(base, { receive: columns("expected_col") }),
        "payload mismatch",
        "payload mismatch, local send against partner receive",
      ),
  },
  {
    id: "payload mismatch, partner receive against local send",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { send: columns("sent_col") }),
        withPayload(base, { receive: columns(value) }),
        "payload mismatch",
        "payload mismatch, partner receive against local send",
      ),
  },
  {
    id: "payload mismatch, partner declared an empty receive",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { send: columns(value) }),
        withPayload(base, { receive: [] }),
        "payload mismatch",
        "payload mismatch, partner declared an empty receive",
      ),
  },
  {
    id: "payload mismatch, local receive against partner send",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { receive: columns(value) }),
        withPayload(base, { send: columns("sent_col") }),
        "payload mismatch",
        "payload mismatch, local receive against partner send",
      ),
  },
  {
    id: "payload mismatch, partner send against local receive",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { receive: columns("expected_col") }),
        withPayload(base, { send: columns(value) }),
        "payload mismatch",
        "payload mismatch, partner send against local receive",
      ),
  },
  {
    id: "payload mismatch, local declared an empty receive",
    benign: "case_id",
    compose: (value) =>
      errorStartingWith(
        withPayload(base, { receive: [] }),
        withPayload(base, { send: columns(value) }),
        "payload mismatch",
        "payload mismatch, local declared an empty receive",
      ),
  },
  {
    id: "partner linkage keys cannot be canonically encoded",
    benign: "big",
    verbatim: false,
    compose: (value) =>
      errorStartingWith(
        base,
        {
          ...base,
          linkageKeys: [
            {
              name: "SSN",
              elements: [
                {
                  field: "ssn",
                  // A transform param beyond 2^53 survives schema parsing and
                  // then fails to canonicalize; the encoder's message names the
                  // offending JSON path, whose last segment is this key.
                  transform: [
                    { function: "noop", params: { [value]: 2 ** 53 } },
                  ],
                },
              ],
            },
          ],
        },
        "partner linkage keys cannot be canonically encoded",
        "partner linkage keys cannot be canonically encoded",
      ),
  },
];

/**
 * The three adversarial value shapes the acceptance criteria name, each built
 * around the benign token the diagnostic would carry anyway.
 */
const ADVERSARIAL_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly shape: (benign: string) => string;
}> = [
  {
    // A value carrying the delimiter itself: undelimited, it closes psilink's
    // own quoted token and opens a second clause.
    name: "a double quote",
    shape: (benign) => `${benign}", partner is "${benign}-forged`,
  },
  {
    // A value carrying the clause separators these diagnostics are built from --
    // every connective at once, including the payload list's punctuation.
    name: "the clause separator",
    shape: (benign) =>
      `${benign}, partner is forged, partner names forged over forged] do not match partner send columns [forged,also_forged`,
  },
  {
    // A value that reads as the "<name> <version>" pair the rule-set clause
    // renders, so an undelimited one passes off a version nobody cited.
    name: "a space-joined version",
    shape: (benign) => `${benign} 9.9.9 over forged-substrate`,
  },
];

/**
 * The clause skeleton a benign run of `diagnostic` produces, with the benign
 * value's own rendering collapsed to the placeholder a delimited run gets.
 *
 * A value that meets the checked bare shape is rendered undelimited, so it leaves
 * no run for {@link readMessage} to collapse -- which is what that shape licenses,
 * since it can carry no delimiter, space, or list punctuation. Normalizing the
 * position here keeps the comparison about STRUCTURE: the hostile run taking the
 * delimited branch is the control working, not a difference to fail on.
 */
const benignClauseSkeleton = (
  diagnostic: SweptDiagnostic,
  compose: (value: string) => string,
): string =>
  readMessage(compose(diagnostic.benign)).skeleton.replaceAll(
    diagnostic.benign,
    "<value>",
  );

describe.each(SWEPT)("$id", (diagnostic) => {
  test.each(ADVERSARIAL_SHAPES)("is not restructured by $name", ({ shape }) => {
    const hostile = shape(diagnostic.benign);
    const hostileRead = readMessage(diagnostic.compose(hostile));

    // The whole claim: an operator reading the hostile run is shown exactly the
    // clause structure this function wrote for the benign one. Nothing the
    // partner chose became prose.
    expect(hostileRead.skeleton).toBe(
      benignClauseSkeleton(diagnostic, diagnostic.compose),
    );
    // And the value is carried whole rather than mangled or split across runs,
    // so the delimiting costs the operator no fidelity.
    if (diagnostic.verbatim !== false)
      expect(hostileRead.values).toContain(hostile);
    // Every shape plants this marker, and none of it survives outside a run.
    expect(hostileRead.skeleton).not.toContain("forged");
    expect(hostileRead.skeleton).not.toContain("<unterminated>");
  });

  test.each(ADVERSARIAL_SHAPES)(
    "survives the display boundary intact under $name",
    ({ shape }) => {
      // The delimiting is composed here and the escape runs once at the sink, so
      // the structure has to hold on what the operator actually sees -- with a
      // control sequence in the value for the escape to act on.
      const render = (message: string): string =>
        sanitizeErrorForDisplay(new Error(message));
      const renderedCompose = (value: string): string =>
        render(diagnostic.compose(value));
      const hostile = `${shape(diagnostic.benign)}\x1b[31m`;
      const rendered = renderedCompose(hostile);

      const renderedSkeleton = readMessage(rendered).skeleton;
      expect(renderedSkeleton).toBe(
        benignClauseSkeleton(diagnostic, renderedCompose),
      );
      expect(renderedSkeleton).not.toContain("forged");
      if (diagnostic.verbatim !== false) {
        // The escape acts inside the run and the run's boundaries are untouched:
        // one pass, not two, and the delimiting survives it.
        expect(rendered).not.toContain("\x1b");
        expect(rendered).toContain("\\x1b");
      }
    },
  );
});

// --- Diagnostics that name no value ------------------------------------------

test("the value-free diagnostics carry no delimiter at all", () => {
  // The rest of the class: fixed first-party copy, which the brand covers the
  // same way but which has no value to delimit. Pinned so a later edit that
  // interpolates a terms value into one of them has to come through the seam --
  // and shows up here as well as at the compiler.
  const valueFree = [
    validateCompatibility(base, {
      ...base,
      output: { expectsOutput: true, shareWithPartner: false },
    }).errors,
    validateCompatibility(
      { ...base, output: { expectsOutput: false, shareWithPartner: false } },
      { ...base, output: { expectsOutput: false, shareWithPartner: false } },
    ).errors,
    validateCompatibility(base, {
      ...base,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "SSN", elements: [{ field: "dob" }] }],
    }).errors,
    validateCompatibility(
      withAgreement(base, "MOU-001", "Care coordination"),
      base,
    ).errors,
    validateCompatibility(
      base,
      withAgreement(base, "MOU-001", "Care coordination"),
    ).errors,
  ].flat();

  expect(valueFree.length).toBeGreaterThan(0);
  for (const message of valueFree)
    expect(message).not.toContain(TERMS_VALUE_DELIMITER);
});

test("each output-mismatch branch reads as a whole sentence", () => {
  // The four readings are spelled out rather than assembled from interpolated
  // phrases, which is what keeps a first-party fragment out of the brand's way.
  const outputErrors = (
    local: LinkageTerms["output"],
    partner: LinkageTerms["output"],
  ): string[] =>
    validateCompatibility(
      { ...base, output: local },
      { ...base, output: partner },
    ).errors.filter((message) => message.startsWith("output mismatch"));

  expect(
    outputErrors(
      { expectsOutput: true, shareWithPartner: true },
      { expectsOutput: false, shareWithPartner: true },
    ),
  ).toEqual([
    "output mismatch: local will share with partner, but partner does not expect output",
  ]);
  expect(
    outputErrors(
      { expectsOutput: true, shareWithPartner: false },
      { expectsOutput: true, shareWithPartner: true },
    ),
  ).toEqual([
    "output mismatch: local will not share with partner, but partner expects output",
  ]);
  expect(
    outputErrors(
      { expectsOutput: true, shareWithPartner: true },
      { expectsOutput: true, shareWithPartner: false },
    ),
  ).toEqual([
    "output mismatch: local expects output, but partner will not share",
  ]);
  expect(
    outputErrors(
      { expectsOutput: false, shareWithPartner: true },
      { expectsOutput: true, shareWithPartner: true },
    ),
  ).toEqual([
    "output mismatch: local does not expect output, but partner will share",
  ]);
});
