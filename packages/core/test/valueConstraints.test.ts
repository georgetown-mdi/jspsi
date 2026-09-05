import { expect, test, describe } from "vitest";

import {
  checkValueConstraints,
  summarizeDatasetConstraintViolations,
} from "../src/valueConstraints";
import { buildStandardizedDataset } from "../src/standardization";
import type { ColumnMetadata } from "../src/config/metadata";
import type {
  LinkageField,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";

// --- checkValueConstraints ---------------------------------------------------

describe("checkValueConstraints", () => {
  test("flags an excluded value across field types and passes one not on the list", () => {
    // `exclude` is shared by every constraint shape, so the denylist is honored
    // for a name as much as for an SSN or an `exclude`-only type (phone_number).
    const name: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { exclude: ["TEST"] },
    };
    const phone: LinkageField = {
      name: "ph",
      type: "phone_number",
      constraints: { exclude: ["0000000000"] },
    };
    expect(checkValueConstraints(name, "TEST").map((v) => v.kind)).toEqual([
      "excluded",
    ]);
    expect(checkValueConstraints(name, "MARY")).toEqual([]);
    expect(
      checkValueConstraints(phone, "0000000000").map((v) => v.kind),
    ).toEqual(["excluded"]);
    expect(checkValueConstraints(phone, "1234567890")).toEqual([]);
  });

  test("flags a name value with a character outside allowedCharacters and passes a conforming one", () => {
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z " },
    };
    // A lowercase residue is outside `A-Z `.
    expect(
      checkValueConstraints(field, "mary").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(checkValueConstraints(field, "MARY JANE")).toEqual([]);
  });

  test("flags an invalid date only under validOnly, and only in canonical YYYYMMDD form", () => {
    const withConstraint: LinkageField = {
      name: "dob",
      type: "date_of_birth",
      constraints: { validOnly: true },
    };
    const withoutConstraint: LinkageField = {
      name: "dob",
      type: "date_of_birth",
    };
    // 2021-02-30 is not a real day.
    expect(
      checkValueConstraints(withConstraint, "20210230").map((v) => v.kind),
    ).toEqual(["invalidDate"]);
    expect(checkValueConstraints(withConstraint, "20210228")).toEqual([]);
    // A value in another output format is not judged (the operator may target it).
    expect(checkValueConstraints(withConstraint, "2021-02-30")).toEqual([]);
    expect(checkValueConstraints(withoutConstraint, "20210230")).toEqual([]);
  });

  test("flags every structurally invalid SSN branch under validOnly, and passes valid forms", () => {
    const field: LinkageField = {
      name: "ssn",
      type: "ssn",
      constraints: { validOnly: true },
    };
    const flaggedSsn = (value: string) =>
      checkValueConstraints(field, value).some((v) => v.kind === "invalidSsn");
    // Each SSA structural rule is its own branch: area 000 / 666 / >= 900, group
    // 00, and serial 0000 are never issued.
    expect(flaggedSsn("000223456")).toBe(true);
    expect(flaggedSsn("666223456")).toBe(true);
    expect(flaggedSsn("900223456")).toBe(true);
    expect(flaggedSsn("123003456")).toBe(true); // group 00
    expect(flaggedSsn("123450000")).toBe(true); // serial 0000
    // A structurally valid 9-digit value, and a non-9-digit value (left to the
    // format-shaping pipeline, not judged here), are not flagged.
    expect(flaggedSsn("123456789")).toBe(false);
    expect(flaggedSsn("12345678")).toBe(false);
  });

  test("flags an ssn4 whose serial is 0000 under validOnly, and passes any other 4-digit value", () => {
    // The last four digits are the SSA serial, whose one structural rule is that
    // it is not 0000; that is the whole judgeable surface for a bare last-four.
    const field: LinkageField = {
      name: "ssn4",
      type: "ssn4",
      constraints: { validOnly: true },
    };
    expect(checkValueConstraints(field, "0000").map((v) => v.kind)).toEqual([
      "invalidSsn4",
    ]);
    expect(checkValueConstraints(field, "0001")).toEqual([]);
    expect(checkValueConstraints(field, "6789")).toEqual([]);
    // Not exactly four digits -> left to the format-shaping pipeline, not judged.
    expect(checkValueConstraints(field, "000")).toEqual([]);
    expect(checkValueConstraints(field, "00000")).toEqual([]);
    // Without validOnly the serial rule does not apply.
    expect(
      checkValueConstraints({ name: "ssn4", type: "ssn4" }, "0000"),
    ).toEqual([]);
  });

  test("does not flag a constraint with no clean value-level test", () => {
    // affixesAllowed is intentionally not checked: a value with a surviving
    // honorific/suffix is not flagged, because affix detection collides with
    // legitimate name values and has no clean value-level test.
    const affix: LinkageField = {
      name: "ln",
      type: "last_name",
      constraints: { affixesAllowed: false },
    };
    expect(checkValueConstraints(affix, "SMITH JR")).toEqual([]);
    expect(checkValueConstraints(affix, "JUDGE")).toEqual([]);
    // An `exclude`-only type with no declared exclusion has nothing to judge.
    expect(
      checkValueConstraints(
        { name: "email", type: "email_address" },
        "a@b.com",
      ),
    ).toEqual([]);
    expect(
      checkValueConstraints(
        { name: "phone", type: "phone_number" },
        "anything",
      ),
    ).toEqual([]);
  });

  test("a partner-crafted allowedCharacters that breaks out of the class cannot stall the check", () => {
    // `allowedCharacters` is partner-controlled and only validated to compile
    // as a `[...]` class body, so this value closes the class and injects a
    // catastrophic-backtracking construct. Matching the whole value against
    // `^[allowed]*$` would hang the thread (ReDoS); testing one character at a
    // time on the linear-time engine returns promptly and still flags it. The
    // test completing under the default timeout is itself the regression guard.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "x](a+)+b[y" },
    };
    const hostile = "x" + "a".repeat(60) + "!";
    expect(
      checkValueConstraints(field, hostile).some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a multi-character match-everything allowedCharacters breakout cannot suppress the warning", () => {
    // `a]|.*[b` breaks the class into match-anything alternation that, applied to
    // the whole value, would never warn. Tested per character, a disallowed
    // value is still flagged -- a multi-character construct cannot match
    // a single code point, so this breakout family cannot turn the warning off.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "a]|.*[b" },
    };
    expect(
      checkValueConstraints(field, "Z@#$").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a shorthand-in-class allowedCharacters admits the code point (accepted advisory limit, not a hole)", () => {
    // Neither the per-code-point test nor the leading-^ negation closure
    // touches a class that admits the code point: `]|\w|[` parses (leading
    // `]` literal) as one class admitting every word character, so a
    // "disallowed" letter is not flagged. Since allowedCharacters only
    // warns, the effect is a suppressed advisory badge -- an accepted
    // limit pinned against silent drift.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "]|\\w|[" },
    };
    // "Z" is a word character the shorthand admits -> not flagged.
    expect(
      checkValueConstraints(field, "Z").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(false);
    // A non-word character is still outside the class -> still flagged, so the
    // class is genuinely evaluated (not blanket-suppressed).
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a leading-^ negated allowedCharacters no longer inverts the advisory", () => {
    // A leading `^` makes re2js read `[^A-Z]` -- the NEGATION of A-Z -- so the class
    // would admit every character EXCEPT A-Z and suppress the warning on arbitrary
    // disallowed input, the opposite of the plain reading ("allow `^` and A-Z, flag
    // the rest"). withinAllowedCharacters escapes the leading `^` to a literal caret,
    // restoring the plain reading. Distinct from the genuine-admission shorthand
    // limit above: this polarity inversion is CLOSED, not accepted.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^A-Z" },
    };
    // A character the plain reading excludes is now flagged -- the negation admitted
    // it (unflagged) before the escape.
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    // A character the plain reading admits -- an uppercase letter, and the caret
    // itself, now a literal member -- is not flagged.
    expect(checkValueConstraints(field, "A")).toEqual([]);
    expect(checkValueConstraints(field, "^")).toEqual([]);
  });

  test("a non-leading caret in allowedCharacters stays a literal allowed character", () => {
    // `^` is special only as the FIRST character of a class; written non-first it is
    // a literal. The leading-^ neutralization must not disturb that: `A-Z^` allows
    // the caret and still flags a genuine outsider.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z^" },
    };
    expect(checkValueConstraints(field, "^")).toEqual([]);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("a leading `^-` is treated as a literal allow-list, not a reversed range", () => {
    // Escaping only the caret would turn `^-Z` into `[\^-Z]` -- a range from
    // `^` (0x5E) down to `Z` (0x5A), which re2js rejects; the compile failure
    // fails open and suppresses the advisory on EVERY value, the unsafe
    // direction. Escaping the `-` after the caret too makes `[\^\-Z]` -- the
    // literal set {`^`, `-`, `Z`} the operator meant -- so the class compiles
    // and the leading-^ vector never suppresses.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^-Z" },
    };
    expect(checkValueConstraints(field, "^")).toEqual([]);
    expect(checkValueConstraints(field, "-")).toEqual([]);
    expect(checkValueConstraints(field, "Z")).toEqual([]);
    // Characters outside the literal set are still flagged -- not blanket-suppressed.
    expect(
      checkValueConstraints(field, "A").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("an alternation-breakout allowedCharacters is still flagged (full match, not unanchored find)", () => {
    // `a]*|` compiles `^[a]*|]$`, which re2js treats as `(^[a]*) | (]$)`: the
    // first branch matches the empty string at the start anchor. An UNANCHORED
    // find would return true for every value and suppress the advisory
    // entirely. The check tests each code point as a FULL match, so a
    // zero-width branch match does not satisfy it and a disallowed value is
    // still flagged, pinned against a regression back to an unanchored find.
    for (const allowedCharacters of ["a]*|", "\\w]*|", "0]?|"]) {
      const field: LinkageField = {
        name: "fn",
        type: "first_name",
        constraints: { allowedCharacters },
      };
      expect(
        checkValueConstraints(field, "!").some(
          (v) => v.kind === "disallowedCharacters",
        ),
      ).toBe(true);
    }
  });

  test("an alternation-breakout class that admits the code point is an accepted limit", () => {
    // `a]|.|[b` compiles `^[a]|.|[b]$` = `(^[a]) | (.) | ([b]$)`: the `.`
    // branch full-matches any code point, so the class admits everything.
    // Unlike the empty-/zero-width-branch breakout above (closed by full
    // match), a branch that genuinely matches one code point cannot be
    // neutralized without rejecting a legitimately permissive class like
    // `[\s\S]` -- distinguishing them would take a full class parser.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "a]|.|[b" },
    };
    expect(checkValueConstraints(field, "!")).toEqual([]);
    expect(checkValueConstraints(field, "Z")).toEqual([]);
  });

  test("an exotic leading-^ class whose escaped form will not compile over-flags, never suppresses", () => {
    // Escaping the leading `^` in `^]A[` to `\^` lets the following `]` close
    // the class, so `[\^]A[]` does not compile. The raw class `[^]A[]` does (a
    // `]` right after `[^` is a literal member), so the escape -- not the
    // partner -- broke it. The check must OVER-flag (the advisory's safe
    // direction), not fail open and suppress the advisory on every value,
    // which a leading-^ negation would otherwise still achieve.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "^]A[" },
    };
    // Every value is flagged -- the advisory is raised, not suppressed.
    expect(
      checkValueConstraints(field, "A").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
    expect(
      checkValueConstraints(field, "!").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });

  test("the empty string conforms to any allowedCharacters class", () => {
    // The per-code-point loop is vacuously true on an empty value: there is no code
    // point to fall outside the class. Pinned so a refactor of the iteration cannot
    // start flagging empty values.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "A-Z" },
    };
    expect(checkValueConstraints(field, "")).toEqual([]);
  });

  test("an allowedCharacters class that cannot compile fails open (no violation)", () => {
    // A class the linear-time engine cannot compile is treated as "cannot check"
    // rather than throwing -- the advisory reports, never blocks, so an
    // uncheckable class must not crash the run or fabricate violations. `z-a` is a
    // reversed range re2js rejects. (For a decoded token NameConstraintsSchema is
    // the safety check; checkValueConstraints is the last line.)
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "z-a" },
    };
    expect(checkValueConstraints(field, "Q")).toEqual([]);
  });

  test("a Unicode property class admits its code points (accepted advisory limit)", () => {
    // `\p{L}` ("any letter") is the natural allowedCharacters for international names
    // and is indistinguishable at the engine level from a shorthand smuggle, so it is
    // an accepted limit, not a hole: neutralizing it would false-flag real non-Latin
    // names. Also pins that the per-code-point iteration handles astral code points
    // (a surrogate pair is one `for...of` step), which a switch to index-based
    // iteration would silently break.
    const field: LinkageField = {
      name: "fn",
      type: "first_name",
      constraints: { allowedCharacters: "\\p{L}" },
    };
    expect(checkValueConstraints(field, "中")).toEqual([]); // CJK letter
    expect(checkValueConstraints(field, "\u{1D4CD}")).toEqual([]); // astral letter
    // A non-letter is still outside the class -> still flagged.
    expect(
      checkValueConstraints(field, "9").some(
        (v) => v.kind === "disallowedCharacters",
      ),
    ).toBe(true);
  });
});

// --- summarizeDatasetConstraintViolations ------------------------------------

describe("summarizeDatasetConstraintViolations", () => {
  const sweepTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "test",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      {
        name: "last_name",
        type: "last_name",
        constraints: { allowedCharacters: "A-Z " },
      },
      {
        name: "date_of_birth",
        type: "date_of_birth",
        constraints: { validOnly: true },
      },
    ],
    linkageKeys: [
      {
        name: "LN+DOB",
        elements: [{ field: "last_name" }, { field: "date_of_birth" }],
      },
    ],
  };
  const metadata: ColumnMetadata[] = [
    { name: "LN", type: "last_name", role: "linkage", isPayload: false },
    { name: "DOB", type: "date_of_birth", role: "linkage", isPayload: false },
  ];

  test("aggregates per (field, kind) across all rows, counting each violating value", () => {
    const rows = [
      { LN: "SMITH", DOB: "19900115" }, // both conform
      { LN: "lower", DOB: "20210230" }, // disallowed chars + invalid date
      { LN: "Mixed", DOB: "20211301" }, // disallowed chars + invalid date
    ];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      metadata,
      sweepTerms,
    );
    const summaries = summarizeDatasetConstraintViolations(
      sweepTerms,
      dataset,
      rows.length,
    );
    expect(
      summaries.map((s) => ({ field: s.field, kind: s.kind, count: s.count })),
    ).toEqual(
      expect.arrayContaining([
        { field: "last_name", kind: "disallowedCharacters", count: 2 },
        { field: "date_of_birth", kind: "invalidDate", count: 2 },
      ]),
    );
    expect(summaries).toHaveLength(2);
    // The aggregate holds the fixed badge caption for the caller to render.
    expect(summaries.find((s) => s.kind === "invalidDate")?.label).toBe(
      "invalid date",
    );
  });

  test("returns nothing when every produced value conforms", () => {
    const rows = [{ LN: "SMITH", DOB: "19900115" }];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      metadata,
      sweepTerms,
    );
    expect(
      summarizeDatasetConstraintViolations(sweepTerms, dataset, rows.length),
    ).toEqual([]);
  });

  test("aggregates exclude-denylist hits across rows (the memoized membership path)", () => {
    // A denylist field swept over multiple rows exercises the per-row reuse the
    // exclude-Set memoization optimizes: the same field (and its `exclude` array)
    // is checked every row, and the aggregate must credit every hit -- including a
    // repeat of the same excluded value on a later row.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { exclude: ["SMITH", "TEST"] },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const rows = [
      { LN: "SMITH" }, // excluded
      { LN: "JONES" }, // conforms
      { LN: "SMITH" }, // excluded again -- second row against the same memoized set
      { LN: "TEST" }, // excluded
    ];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([
      {
        field: "last_name",
        kind: "excluded",
        label: "excluded value",
        count: 3,
      },
    ]);
  });

  test("a field with no declared constraints, or absent from the dataset, contributes nothing", () => {
    // last_name has no constraints; date_of_birth resolves to no column (its
    // metadata column is missing), so neither contributes a summary.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        { name: "last_name", type: "last_name" },
        {
          name: "date_of_birth",
          type: "date_of_birth",
          constraints: { validOnly: true },
        },
      ],
    };
    const rows = [{ LN: "lower" }];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([]);
  });

  test("judges a fan-out value per candidate", () => {
    // split_on fans "AAAA BBBB" into two name candidates; the lowercase-residue
    // check runs on each, so a two-candidate row contributes two violations.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "split_on", params: { delimiter: " " } }],
      },
    ];
    const rows = [{ LN: "aa bb" }];
    const dataset = buildStandardizedDataset(
      standardization,
      rows,
      [{ name: "LN", type: "last_name", role: "linkage", isPayload: false }],
      terms,
    );
    const summaries = summarizeDatasetConstraintViolations(
      terms,
      dataset,
      rows.length,
    );
    expect(summaries).toEqual([
      {
        field: "last_name",
        kind: "disallowedCharacters",
        label: "disallowed characters",
        count: 2,
      },
    ]);
  });

  test("skips a constrained field no linkage key references, still reports a referenced one", () => {
    // Both fields are declared, constrained, resolve to a column, and have a
    // value that violates their constraints. Only `last_name` is referenced by a
    // linkage key; `first_name` is declared-but-unreferenced, so the exchange
    // never standardizes or consumes it and the sweep must not warn on it.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
        {
          name: "first_name",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
    };
    const rows = [{ LN: "smith", FN: "jane" }]; // both lowercase -> both violate A-Z
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [
        { name: "LN", type: "last_name", role: "linkage", isPayload: false },
        { name: "FN", type: "first_name", role: "linkage", isPayload: false },
      ],
      terms,
    );
    // The unreferenced first_name DOES resolve to a column (it is present in the
    // dataset), so its exclusion is the referenced-scoping at work, not the
    // resolved-to-no-column path the prior test covers.
    expect(dataset.getField("first_name")).toBeDefined();
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual([
      {
        field: "last_name",
        kind: "disallowedCharacters",
        label: "disallowed characters",
        count: 1,
      },
    ]);
  });

  test("sweeps every field a swap key references, unaffected by the swap", () => {
    // Encodes the referenced-set comment's swap-invariance claim as a check: the
    // sweep reads the un-swapped `element.field`, and `swap` only permutes which
    // slot holds which field, so the set of fields it sweeps is identical with or
    // without the swap. Both swapped fields are constrained and violate, so both
    // must be reported -- a field reachable only through the swap is not missed.
    const terms: LinkageTerms = {
      ...sweepTerms,
      linkageFields: [
        {
          name: "first_name",
          type: "first_name",
          constraints: { allowedCharacters: "A-Z" },
        },
        {
          name: "last_name",
          type: "last_name",
          constraints: { allowedCharacters: "A-Z" },
        },
      ],
      linkageKeys: [
        {
          name: "swap(FN,LN)",
          elements: [{ field: "first_name" }, { field: "last_name" }],
          swap: ["first_name", "last_name"],
        },
      ],
    };
    const rows = [{ FN: "jane", LN: "smith" }]; // both lowercase -> both violate A-Z
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      [
        { name: "FN", type: "first_name", role: "linkage", isPayload: false },
        { name: "LN", type: "last_name", role: "linkage", isPayload: false },
      ],
      terms,
    );
    expect(
      summarizeDatasetConstraintViolations(terms, dataset, rows.length),
    ).toEqual(
      expect.arrayContaining([
        {
          field: "first_name",
          kind: "disallowedCharacters",
          label: "disallowed characters",
          count: 1,
        },
        {
          field: "last_name",
          kind: "disallowedCharacters",
          label: "disallowed characters",
          count: 1,
        },
      ]),
    );
  });
});
