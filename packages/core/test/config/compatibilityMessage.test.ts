import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  BARE_TERMS_VALUE_PATTERN,
  MAX_BARE_TERMS_VALUE_LENGTH,
  TERMS_VALUE_DELIMITER,
  bareTermsValue,
  compatibilityMessage,
  quoteTermsValue,
  quoteTermsValueList,
  ruleSetCitation,
} from "../../src/config/compatibilityMessage";
import { validateCompatibility } from "../../src/linkageTermsNegotiation";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import {
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "../../src/utils/sanitizeErrorForDisplay";
import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  controlCharacterMarker,
  replaceControlCharactersForDisplay,
  sanitizeForDisplay,
} from "../../src/utils/sanitizeForDisplay";
import { readMessage } from "../utils/compatibilityMessageReader";

// --- Reading a composed diagnostic back --------------------------------------

test("the reader recovers exactly what the boundary delimited", () => {
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

// --- The delimiting constructors ---------------------------------------------

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

  test("no value renders as a control character the composition placed", () => {
    // The delimiting above bounds what a value can do in PRINTABLE bytes; this
    // is the same bound one level up, where a composition's own structure is a
    // control character -- a block separates its lines with `\n`, escaped
    // whole where shown. The escape treats that line break and a value's own
    // alike, so the delimiting boundary must cover every control character,
    // not just the line break, since it cannot know which ones a composition
    // uses to build structure.
    for (let codePoint = 0; codePoint <= 0x9f; codePoint += 1) {
      const character = String.fromCodePoint(codePoint);
      if (!/\p{Cc}/u.test(character)) continue;
      const quoted = quoteTermsValue(`a${character}b`);
      const where = `U+${codePoint.toString(16).padStart(4, "0")}`;
      expect(quoted, where).toBe(`"a${controlCharacterMarker(codePoint)}b"`);
      // What the operator meets: the escape has nothing left to act on, and the
      // token it writes for a composition's own control character is nowhere in
      // the run.
      expect(sanitizeForDisplay(quoted), where).toBe(quoted);
      expect(sanitizeForDisplay(quoted), where).not.toContain(
        sanitizeForDisplay(character),
      );
    }
  });

  test("the treatment is idempotent and adds no run boundary of its own", () => {
    // It runs at a composition site, and a value may pass more than one before
    // it is shown (a fragment redacted and delimited by a producer, then
    // included in a wider clause), so a second pass must be a no-op rather
    // than a second marker over the first.
    const value = "a\nb\tc\x7fd";
    const once = replaceControlCharactersForDisplay(value);
    expect(replaceControlCharactersForDisplay(once)).toBe(once);
    expect(once).not.toContain(TERMS_VALUE_DELIMITER);
    expect(once).not.toContain("\\");
    expect(quoteTermsValue(value)).toBe(`"${once}"`);
  });
});

describe("bareTermsValue", () => {
  test("renders a schema-shaped value undelimited", () => {
    for (const value of ["1.0.0", "2.0.0", "2030-01-01", "9"])
      expect(bareTermsValue(value)).toBe(value);
  });

  test("falls back to the delimited form for anything else", () => {
    // The assumption "the schema constrains this field" is CHECKED on the value
    // in hand rather than assumed of the caller: validateCompatibility's
    // signature takes two LinkageTerms objects and nothing in it makes them
    // schema-parsed.
    for (const value of [
      "",
      "psi",
      "psi-c",
      "single-pass",
      '1.0.0", partner is "9.9.9',
      "1.0.0, partner is 9.9.9",
      "1.0.0 9.9.9",
      "2030-01-01\x1b[31m",
      "0".repeat(MAX_BARE_TERMS_VALUE_LENGTH + 1),
    ]) {
      expect(bareTermsValue(value)).toBe(quoteTermsValue(value));
      // Recovered as the delimiting boundary renders it, which is the raw
      // value but for the control characters the quoted branch treats:
      // the bare branch is where a value would otherwise reach a clause
      // both undelimited and untreated, so the ANSI case above is what
      // pins that it cannot.
      expect(readMessage(bareTermsValue(value)).values).toEqual([
        replaceControlCharactersForDisplay(value),
      ]);
    }
  });

  test("the bare shape contains nothing a clause boundary is made of", () => {
    // Half of what licenses rendering a value bare at all: the payload list is
    // built from `,`, `[`, and `]`, and a run is closed by the delimiter, so a
    // shape admitting none of those cannot reach for the structure around it.
    // Each case has a digit so it is the character under test that fails it
    // rather than the digit requirement below.
    //
    // The last three are the non-ASCII characters a charset relaxation
    // would most plausibly admit: a class widened for a non-ASCII set
    // name -- anything but the clause characters and ASCII whitespace --
    // takes all three, and one widened only to exclude JavaScript's `\s`
    // still takes the zero-width space, which that class does not count
    // as whitespace. Each breaks the assumption the bare form rests on,
    // that a value the shape admits is exactly one token, in a way none of
    // the ASCII cases above does: the first two separate a token or break
    // a line while the ASCII whitespace class names neither, and the third
    // is invisible, so the token a reader sees is not the
    // one the vocabulary check measured. Named rather than listed bare so a
    // failure says which character got through.
    for (const [name, forbidden] of [
      ["the delimiter", TERMS_VALUE_DELIMITER],
      ["a space", " "],
      ["a comma", ","],
      ["an opening bracket", "["],
      ["a closing bracket", "]"],
      ["a newline", "\n"],
      ["a no-break space", "\u00a0"],
      ["a line separator", "\u2028"],
      ["a zero-width space", "\u200b"],
    ])
      expect(BARE_TERMS_VALUE_PATTERN.test(`a1${forbidden}b`), name).toBe(
        false,
      );
  });

  test("a value with no digit is not bare-shaped", () => {
    // The other half. Excluding the space makes a bare value exactly one
    // whitespace-delimited token, which on its own does NOT keep it out of a
    // connective position: the TEMPLATE supplies the spaces around a bare slot,
    // so a letters-only value would stand in the clause as undelimited as the
    // connective beside it. The digit is what separates the two vocabularies --
    // every value these diagnostics render bare has one, and no token of
    // first-party copy does, which the templates themselves are held to below.
    for (const value of [
      "over",
      "names",
      "local",
      "is",
      "match",
      "payload.receive",
      "psi-c",
    ])
      expect(BARE_TERMS_VALUE_PATTERN.test(value)).toBe(false);
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

describe("ruleSetCitation", () => {
  test("renders the name delimited and a schema-shaped version bare", () => {
    // The pair every surface showing a citation renders, pinned here so the one
    // grammar core's mismatch diagnostic, both consent surfaces, and the CLI's
    // drift warning share is asserted where it is written rather than only in
    // each of their renderings.
    expect(ruleSetCitation("hmis-keys", "1.2.0")).toBe('"hmis-keys" 1.2.0');
  });

  test("a name cannot spell the pair beside it", () => {
    // What the delimiting is for: a name displaying as a name plus a version,
    // or holding a delimiter of its own, stays one run rather than standing
    // in the citation as a set at a version the invitation does not name.
    const citation = ruleSetCitation('hmis-keys 9.9.9" over "other', "1.2.0");
    expect(citation).toBe('"hmis-keys 9.9.9"" over ""other" 1.2.0');
    const read = readMessage(citation);
    expect(read.values).toEqual(['hmis-keys 9.9.9" over "other']);
    expect(read.skeleton).toBe("<value> 1.2.0");
  });

  test("a version outside the bare shape takes the delimited run", () => {
    // Checked on the value in hand: a citation reaches these surfaces from a
    // partner's decoded invitation as readily as from a schema parse.
    const version = '1.2.0" over "forged';
    expect(ruleSetCitation("hmis-keys", version)).toBe(
      `"hmis-keys" ${quoteTermsValue(version)}`,
    );
    expect(readMessage(ruleSetCitation("hmis-keys", version)).values).toEqual([
      "hmis-keys",
      version,
    ]);
  });
});

test("a raw terms value cannot be composed into a diagnostic", () => {
  // The compile-time half of the sweep: the tagged template takes only
  // fragments the delimiting boundary produced, so dropping a delimiter
  // is a build failure rather than a review catch. Both accumulators in
  // validateCompatibility hold the same brand, which is what extends this
  // from one call to every message in the function.
  const partnerChosen: string = 'MOU-001", partner is "MOU-666';
  // @ts-expect-error a plain string is not a CompatibilityMessageFragment
  const composed = compatibilityMessage`local is ${partnerChosen}`;
  // The runtime is unaffected -- the guarantee is the type error above, and this
  // keeps the binding used so the assertion is not silently dropped.
  expect(composed).toContain("local is ");
});

// --- The vocabulary a bare value must not be able to spell --------------------

const DIAGNOSTIC_MODULE_PATH = fileURLToPath(
  new URL("../../src/linkageTermsNegotiation.ts", import.meta.url),
);
const DIAGNOSTIC_MODULE_SOURCE = readFileSync(DIAGNOSTIC_MODULE_PATH, "utf8");

/**
 * The fixed first-party spans of every `compatibilityMessage` template in
 * `validateCompatibility`'s own module, one string per template with each
 * interpolation replaced by a space.
 *
 * Parsed with the compiler API rather than matched with a regex over the source
 * text: a template's fixed spans are what the compiler hands the tag, so a
 * template that nests a backtick -- escaped, or inside a nested literal in one of
 * its own interpolations -- is read whole instead of silently truncated at that
 * backtick, which would drop the copy behind it from the vocabulary below without
 * failing anything.
 */
const diagnosticTemplates = (): string[] => {
  const parsed = ts.createSourceFile(
    DIAGNOSTIC_MODULE_PATH,
    DIAGNOSTIC_MODULE_SOURCE,
    ts.ScriptTarget.Latest,
    true,
  );
  const templates: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === "compatibilityMessage"
    )
      templates.push(
        ts.isNoSubstitutionTemplateLiteral(node.template)
          ? node.template.text
          : [
              node.template.head.text,
              ...node.template.templateSpans.map((span) => span.literal.text),
            ].join(" "),
      );
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  // A call site the walk failed to reach would shrink the vocabulary without
  // failing anything, so the count is tied back to the call sites as the source
  // text spells them -- an independent count of the same thing.
  expect(templates).toHaveLength(
    DIAGNOSTIC_MODULE_SOURCE.split("compatibilityMessage`").length - 1,
  );
  return templates;
};

/**
 * Every token of first-party copy the compatibility diagnostics are built from.
 *
 * Read out of the templates rather than restated here, so the vocabulary cannot
 * fall behind a template edit: a diagnostic reworded to include a digit in its
 * prose fails the assertion below instead of silently reopening the bare form's
 * connective position.
 */
const firstPartyTokens = (): string[] =>
  [
    ...new Set(
      diagnosticTemplates().flatMap((template) => template.split(/\s+/)),
    ),
  ].filter((token) => token.length > 0);

test("no connective or label the diagnostics are built from is bare-shaped", () => {
  // The argument the bare form rests on, as a check rather than as prose. A bare
  // value has no space, so it is exactly one token wherever the template
  // drops it; if no token the templates are built from can meet the bare shape,
  // then no bare value can be read as a connective or a label this function
  // wrote, whatever the partner chose. The digit requirement is what makes the
  // two vocabularies disjoint, so a pattern relaxed to admit a digit-free value
  // -- or a connective reworded to include a digit -- fails here.
  const tokens = firstPartyTokens();
  expect(tokens).toEqual(
    expect.arrayContaining([
      "over",
      "names",
      "local",
      "is",
      "do",
      "not",
      "match",
      "payload.receive",
    ]),
  );
  for (const token of tokens)
    expect(BARE_TERMS_VALUE_PATTERN.test(token), token).toBe(false);
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

/**
 * A diagnostic together with the accumulator it arrived on. The route travels
 * with the message because it decides the display pipeline that sends it to an
 * operator, and the two differ in how many times the escape runs. It is produced
 * by the two helpers below rather than declared per entry, so a case is rendered
 * through the route `validateCompatibility` actually put it on.
 */
interface RoutedDiagnostic {
  readonly route: "errors" | "warnings";
  readonly message: string;
}

const errorStartingWith = (
  local: LinkageTerms,
  partner: LinkageTerms,
  marker: string,
  id: string,
): RoutedDiagnostic => ({
  route: "errors",
  message: only(validateCompatibility(local, partner).errors, marker, id),
});

const warningStartingWith = (
  local: LinkageTerms,
  partner: LinkageTerms,
  marker: string,
  id: string,
): RoutedDiagnostic => ({
  route: "warnings",
  message: only(validateCompatibility(local, partner).warnings, marker, id),
});

/**
 * Render a diagnostic through the pipeline its own route has in production,
 * which is what the display-side assertions below have to hold on.
 *
 * An `errors` diagnostic is composed RAW and becomes an `Error` message where
 * the terms exchange refuses (`protocolSetup.ts` joins the list behind this same
 * lead-in), so the escape runs once, at the renderer that shows the chain. A
 * `warnings` diagnostic is composed ESCAPED -- `validateCompatibility` wraps each
 * value in `redactAndSanitizeForDisplay` -- and is handed to `runExchange`'s
 * `onWarning` as display text, whose CLI sink escapes the whole composed warning
 * a second time: at the stderr log line (`apps/cli/src/protocol.ts`) and at the
 * fd-3 warning event (`buildWarningEvent` in `apps/cli/src/eventStream.ts`,
 * whose whole-warning budget is the cap taken here). That two-pass route is one
 * CHANNEL_SECURITY.md records rather than closes.
 */
const renderForRoute = ({ route, message }: RoutedDiagnostic): string =>
  route === "errors"
    ? sanitizeErrorForDisplay(
        new Error(`linkage terms are incompatible: ${message}`),
      )
    : redactAndSanitizeForDisplay(message, {
        maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
      });

/**
 * A code point outside printable ASCII that is NOT a control character, which is
 * what the escape-count assertions below count passes with.
 *
 * The escape rewrites it and the delimiting boundary's control-character
 * treatment does not, so it is the one class of byte that still reaches
 * the display boundary from inside a value: a control character would be
 * replaced at composition and count no passes at all.
 */
const NON_ASCII_CODE_POINT = "é";

/** What ONE escape pass writes for {@link NON_ASCII_CODE_POINT}. */
const ONCE_ESCAPED_NON_ASCII = "\\xe9";

/**
 * What a SECOND pass writes over that, the first pass's backslash doubled. It
 * CONTAINS the once-escaped form, so an assertion that only looks for that form
 * is satisfied by either: a single-pass route is pinned by the absence of this
 * one, and the two-pass route by its presence.
 */
const TWICE_ESCAPED_NON_ASCII = "\\\\xe9";

/**
 * How a COMPOSITION's own control character renders once a route has escaped it,
 * for the ESC the hostile values below hold -- the token a value must not be
 * able to produce, since a composition builds its structure (a block's line
 * breaks) out of exactly these.
 */
const ESCAPED_ESC = "\\x1b";

/** What a SECOND escape pass writes over that, the first pass's backslash doubled. */
const TWICE_ESCAPED_ESC = "\\\\x1b";

/** The same ESC as the delimiting boundary's treatment renders it, read off the
 * constructor. */
const TREATED_ESC = controlCharacterMarker(0x1b);

/**
 * Every VALUE SLOT of every compatibility diagnostic that names a terms value,
 * with the value under test threaded through it: one entry per slot, so both
 * sides of a two-slot comparison and each of the four the rule-set clause
 * renders are driven rather than one standing in for the rest -- the two sides
 * of a slot pair are separate interpolations, and a delimiter dropped from
 * either is a separate defect. Each entry supplies a benign token the case would
 * have anyway, and the adversarial shapes below are built AROUND that token, so
 * a benign run and a hostile run of the same entry differ in nothing but the
 * value.
 *
 * The compile-time half of the sweep is separate and stronger -- the brand on
 * validateCompatibility's accumulators, exercised above -- so this table does not
 * have to be exhaustive on its own; it shows the delimiting actually holds on
 * each message an operator can be shown.
 */
interface SweptDiagnostic {
  readonly id: string;
  /** A value of the shape this diagnostic legitimately has. */
  readonly benign: string;
  /**
   * Produce the diagnostic with `value` in the partner-chosen position, on the
   * accumulator `validateCompatibility` returned it on.
   */
  readonly compose: (value: string) => RoutedDiagnostic;
  /**
   * Whether the value reaches the message byte-for-byte. False only where the
   * message names the value through another encoding of its own -- the canonical
   * encoder's JSON-quoted path -- which re-escapes before the delimiting
   * boundary sees it.
   */
  readonly verbatim?: false;
  /**
   * Whether `value` can reach this diagnostic at all.
   *
   * Declared by the one entry whose branch is a PREDICATE on the value -- the
   * expiry check fires for a date that sorts before today -- where every other
   * branch compares the two documents and fires for any two values that differ.
   * A shape whose value misses the predicate would leave the diagnostic unraised
   * rather than restructured, which is not what these assertions are about, so it
   * is held out by name in the test listing. The hold-out is bounded to a single
   * entry per shape by the assertion below, so it cannot grow into a way to
   * silence a shape that fails.
   */
  readonly reachedBy?: (value: string) => boolean;
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
    id: "rule set mismatch, local field set name",
    benign: "baseline-pii",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: value, version: "1.0.0" },
        ),
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: "other-pii", version: "2.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, local field set name",
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
    id: "rule set mismatch, local key set version",
    benign: "2.0.0",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "hmis-keys", version: value },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        withRuleSet(
          base,
          { name: "other-keys", version: "1.0.0" },
          { name: "baseline-pii", version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, local key set version",
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
    id: "rule set mismatch, local field set version",
    benign: "2.0.0",
    compose: (value) =>
      errorStartingWith(
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: "baseline-pii", version: value },
        ),
        withRuleSet(
          base,
          { name: "hmis-keys", version: "1.0.0" },
          { name: "other-pii", version: "1.0.0" },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, local field set version",
      ),
  },
  {
    id: "rule set mismatch, partner field set version",
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
          { name: "hmis-keys", version: "1.0.0" },
          { name: "other-pii", version: value },
        ),
        "linkage rule set mismatch",
        "rule set mismatch, partner field set version",
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
    id: "legal agreement expiration date mismatch, local side",
    benign: "2031-06-30",
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", "Care coordination", value),
        withAgreement(base, "MOU-001", "Care coordination", "2030-01-01"),
        "legal agreement expiration date mismatch",
        "legal agreement expiration date mismatch, local side",
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
    reachedBy: (value) => value < new Date().toISOString().slice(0, 10),
    compose: (value) =>
      errorStartingWith(
        withAgreement(base, "MOU-001", "Care coordination", value),
        withAgreement(base, "MOU-001", "Care coordination", value),
        "legal agreement expired on",
        "legal agreement expired on",
      ),
  },
  {
    id: "version mismatch, local side",
    benign: "2.0.0",
    compose: (value) =>
      errorStartingWith(
        { ...base, version: value },
        base,
        "version mismatch",
        "version mismatch, local side",
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
    id: "algorithm mismatch, local side",
    benign: "psi-c",
    compose: (value) =>
      errorStartingWith(
        { ...base, algorithm: value as LinkageTerms["algorithm"] },
        base,
        "algorithm mismatch",
        "algorithm mismatch, local side",
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
    id: "linkage strategy mismatch, local side",
    benign: "single-pass",
    compose: (value) =>
      errorStartingWith(
        {
          ...base,
          linkageStrategy: value as LinkageTerms["linkageStrategy"],
        },
        base,
        "linkage strategy mismatch",
        "linkage strategy mismatch, local side",
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
    id: "date mismatch warning, local side",
    benign: "2025-06-01",
    compose: (value) =>
      warningStartingWith(
        { ...base, date: value },
        base,
        "date mismatch",
        "date mismatch warning, local side",
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
 * The adversarial value shapes, each built around the benign token the
 * diagnostic would have anyway. The first three reach the delimiting
 * boundary's DELIMITED branch, whose hostile case is a value holding a
 * delimiter or a space; the last two reach its BARE branch, whose hostile case
 * is a value the checked bare shape admits and the template then surrounds
 * with spaces of its own.
 */
const ADVERSARIAL_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly shape: (benign: string) => string;
  /** A token the shape plants that must not survive as first-party structure. */
  readonly marker?: string;
}> = [
  {
    // A value holding the delimiter itself: undelimited, it closes psilink's
    // own quoted token and opens a second clause.
    name: "a double quote",
    shape: (benign) => `${benign}", partner is "${benign}-forged`,
    marker: "forged",
  },
  {
    // A value holding the clause separators these diagnostics are built from --
    // every connective at once, including the payload list's punctuation.
    name: "the clause separator",
    shape: (benign) =>
      `${benign}, partner is forged, partner names forged over forged] do not match partner send columns [forged,also_forged`,
    marker: "forged",
  },
  {
    // A value that displays as the "<name> <version>" pair the rule-set clause
    // renders, so an undelimited one passes off a version nobody cited.
    name: "a space-joined version",
    shape: (benign) => `${benign} 9.9.9 over forged-substrate`,
    marker: "forged",
  },
  {
    // A bare connective, which the other three cannot be: each has a space or
    // a comma, so each is delimited whatever the value slot does with it. This
    // one is the delimiting boundary's charset throughout and spells the
    // rule-set clause's own " over " with none of the space -- the template
    // supplies that -- so it is the shape the digit requirement exists for, and
    // it takes the delimited branch only because it has no digit. It plants no
    // marker: it IS a token the templates are built from, which is the whole of
    // the attack.
    name: "a bare connective",
    shape: () => "over",
  },
  {
    // The bare branch's own hostile case: still the delimiting boundary's
    // charset, and this one DOES have a digit, so it renders undelimited into
    // a slot the template spaces on both sides. What holds there is the
    // vocabulary argument rather than a delimiter -- one token, and not one
    // the templates are built from.
    name: "a bare digit-carrying connective",
    shape: (benign) => `${benign}9over-forged`,
    marker: "forged",
  },
];

/**
 * The clause skeleton `rendered` shows an operator, with the terms value `value`
 * collapsed to one placeholder whichever of the delimiting boundary's two
 * forms it took.
 *
 * A delimited run is collapsed by {@link readMessage} itself. A value that meets
 * the checked bare shape leaves no run to collapse -- which is what that shape
 * licenses -- so its own text is collapsed here instead. Normalizing both forms
 * to the same placeholder keeps the comparison about STRUCTURE: which branch
 * the delimiting boundary took for a given value is the control choosing a
 * rendering, not a difference to fail on. What makes collapsing the bare
 * form sound is the vocabulary check above -- a bare value is one token,
 * and no token these templates are built from can be bare-shaped -- so a
 * bare value cannot be standing where a connective would.
 *
 * The bare form is collapsed ONCE, at the slot the template rendered it into,
 * rather than everywhere it occurs. A slot is driven by exactly one entry above,
 * so one occurrence is what a correct message holds; collapsing every copy would
 * erase a second one the composition wrote -- a value echoed into a slot beside
 * its own -- from both the skeleton comparison and the marker assertion, which is
 * the whole of what either has to say about a value rendered bare.
 */
const clauseSkeleton = (rendered: string, value: string): string => {
  const { skeleton } = readMessage(rendered);
  return bareTermsValue(value) === value
    ? skeleton.replace(value, "<value>")
    : skeleton;
};

/**
 * The value the display-route assertions use: the shape with an ANSI control
 * sequence and a non-ASCII code point appended, so the route they run through
 * contains one byte the delimiting boundary treats and one the escape acts on.
 */
const withControlSequence = (shaped: string): string =>
  `${shaped}\x1b[31m${NON_ASCII_CODE_POINT}`;

/** The shapes that reach `diagnostic` at all, by its own stated predicate. */
const shapesReaching = (
  diagnostic: SweptDiagnostic,
  asValue: (shaped: string) => string = (shaped) => shaped,
) =>
  ADVERSARIAL_SHAPES.filter(
    ({ shape }) =>
      diagnostic.reachedBy?.(asValue(shape(diagnostic.benign))) !== false,
  );

test("every adversarial shape is swept across all but one diagnostic", () => {
  // The bound on the hold-out above: a shape may miss at most the single
  // value-predicated branch, so `reachedBy` cannot become a way to drop a shape
  // from the sweep it fails.
  for (const shape of ADVERSARIAL_SHAPES)
    for (const asValue of [(shaped: string) => shaped, withControlSequence])
      expect(
        SWEPT.filter((diagnostic) =>
          shapesReaching(diagnostic, asValue).includes(shape),
        ).length,
        shape.name,
      ).toBeGreaterThanOrEqual(SWEPT.length - 1);
});

test("a hostile value does reach the boundary's bare branch", () => {
  // Otherwise the shapes above would say nothing about the branch the digit
  // requirement governs: every slot could quote every one of them and the sweep
  // would still pass. A value is rendered bare where the message holds it
  // undelimited, which is exactly where readMessage recovers no run for it.
  const bareShapes = ADVERSARIAL_SHAPES.filter(
    ({ shape }) => bareTermsValue(shape("1.0.0")) === shape("1.0.0"),
  );
  expect(bareShapes.length).toBeGreaterThan(0);
  for (const { name, shape } of bareShapes) {
    const carriedBare = SWEPT.filter((diagnostic) => {
      const hostile = shape(diagnostic.benign);
      if (bareTermsValue(hostile) !== hostile) return false;
      const message = diagnostic.compose(hostile).message;
      return (
        message.includes(hostile) &&
        !readMessage(message).values.includes(hostile)
      );
    });
    expect(carriedBare.length, name).toBeGreaterThan(0);
  }
});

describe.each(SWEPT)("$id", (diagnostic) => {
  const composed = (value: string): string => diagnostic.compose(value).message;
  const displayed = (value: string): string =>
    renderForRoute(diagnostic.compose(value));

  test.each(shapesReaching(diagnostic))(
    "is not restructured by $name",
    ({ shape, marker }) => {
      const hostile = shape(diagnostic.benign);
      const hostileMessage = composed(hostile);
      const hostileSkeleton = clauseSkeleton(hostileMessage, hostile);

      // The whole claim: an operator reading the hostile run is shown exactly the
      // clause structure this function wrote for the benign one. Nothing the
      // partner chose became prose.
      expect(hostileSkeleton).toBe(
        clauseSkeleton(composed(diagnostic.benign), diagnostic.benign),
      );
      // And the value is rendered whole rather than mangled or split, so the
      // delimiting costs the operator no fidelity: inside one run, or -- where
      // the checked bare shape let it through -- verbatim in the clause.
      if (diagnostic.verbatim !== false)
        expect(
          readMessage(hostileMessage).values.includes(hostile) ||
            (bareTermsValue(hostile) === hostile &&
              hostileMessage.includes(hostile)),
          `the value is not carried whole: ${hostileMessage}`,
        ).toBe(true);
      if (marker !== undefined) expect(hostileSkeleton).not.toContain(marker);
      expect(hostileSkeleton).not.toContain("<unterminated>");
    },
  );

  test.each(shapesReaching(diagnostic, withControlSequence))(
    "survives its own display route intact under $name",
    ({ shape, marker }) => {
      // The delimiting is composed in validateCompatibility and the escape runs
      // on the route that sends the diagnostic away from it, so the structure
      // has to hold on what the operator actually sees -- with a control
      // sequence in the value for the escape to act on.
      const hostile = withControlSequence(shape(diagnostic.benign));
      const routed = diagnostic.compose(hostile);
      const rendered = renderForRoute(routed);

      const renderedSkeleton = clauseSkeleton(rendered, hostile);
      expect(renderedSkeleton).toBe(
        clauseSkeleton(displayed(diagnostic.benign), diagnostic.benign),
      );
      if (marker !== undefined) expect(renderedSkeleton).not.toContain(marker);
      if (diagnostic.verbatim !== false) {
        // The control character is gone from the operator's text, and gone in a
        // form a composition's own control character cannot be confused with.
        // Which form differs by route, because the two escape in a different
        // ORDER, and each is what the property rests on there.
        expect(rendered).not.toContain("\x1b");
        if (routed.route === "errors") {
          // Composed raw and escaped once at the renderer, so a composition's
          // own control character IS the once-escaped token. The delimiting
          // boundary's treatment is what keeps a value from spelling it.
          expect(rendered).not.toContain(ESCAPED_ESC);
          expect(rendered).toContain(TREATED_ESC);
        } else {
          // Escaped at composition, ahead of the delimiting boundary,
          // so nothing is left for the treatment to act on and the sink's
          // second pass doubles the backslash the first wrote. The value's
          // control character therefore arrives one backslash wider than
          // a composition's own would -- the doubling CHANNEL_SECURITY.md
          // records for this route, standing here as the same distinction.
          expect(rendered).toContain(TWICE_ESCAPED_ESC);
        }
        // The escape acted inside the run and left the run's boundaries
        // untouched, and it ran as many times as this route escapes: once at
        // the error renderer, or -- on the warnings route -- once at composition
        // and once at the sink. Counted on a non-ASCII code point rather than a
        // control character, which the delimiting boundary replaces ahead of
        // the escape on the errors route. That doubling is reachable here
        // because validateCompatibility's signature admits terms no schema
        // parsed; a date that came through the terms schema has no byte the
        // escape rewrites at all, which linkageTermsSchema.test.ts pins.
        if (routed.route === "errors") {
          expect(rendered).toContain(ONCE_ESCAPED_NON_ASCII);
          expect(rendered).not.toContain(TWICE_ESCAPED_NON_ASCII);
        } else {
          expect(rendered).toContain(TWICE_ESCAPED_NON_ASCII);
        }
      }
    },
  );
});

// --- Diagnostics that name no value ------------------------------------------

test("the value-free diagnostics contain no delimiter at all", () => {
  // The rest of the class: fixed first-party copy, which the brand covers the
  // same way but which has no value to delimit. Pinned so a later edit that
  // interpolates a terms value into one of them has to come through the
  // delimiting boundary --
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

test("each output-mismatch branch displays as a whole sentence", () => {
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
