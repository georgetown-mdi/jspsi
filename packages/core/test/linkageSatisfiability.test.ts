import { expect, test, describe } from "vitest";

import {
  runPipeline,
  buildStandardizedDataset,
  buildKeyStrings,
  compileSteps,
  hasMemoizedCompiledSteps,
  FAN_OUT_FUNCTION_NAMES,
  StandardizedField,
  StandardizedDataset,
  STANDARDIZATION_FUNCTION_NAMES,
  type FieldValue,
} from "../src/standardization";
import {
  validateStandardizationAgainstTerms,
  assertFanOutImplemented,
  assertStandardizationMatchesTerms,
  assertTransformsCompile,
  unsatisfiedLinkageFields,
  assessLinkageSatisfiability,
  assertLinkageTermsSatisfiable,
  decideLinkageTermsVerdict,
  summarizeLinkageShortfall,
  coalesceSubstitutesConstant,
  substringCollapsesParsedDateToConstant,
  substringRunDropsEveryParsedDate,
  substringWindowDropsEveryValue,
  LAYOUT_DETERMINED_FUNCTION_NAMES,
  DATE_COLLAPSE_PROBES,
  CONSENT_VERDICT_PARAM_NAMES,
  stepCanEmptyRealizedValue,
  pipelineAlwaysDrops,
  parseDateInputDropsEveryRecord,
  type LinkageTermsStanding,
} from "../src/linkageSatisfiability";
import {
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  UnknownStandardizationFunctionError,
  UsageError,
} from "../src/errors";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { inferMetadata } from "../src/config/metadata";
import type { ColumnMetadata, Metadata } from "../src/config/metadata";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  linkageTermsFromRuleSet,
} from "../src/defaults/builtInLinkageTerms";
import { getDefaultStandardization } from "../src/defaults/builtInStandardization";
import type {
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  TransformStep,
} from "../src/config/linkageTermsSchema";
import type { Standardization } from "../src/config/standardizationSchema";
import { safeParseLinkageTerms } from "../src/config/linkageTermsSchema";

const col = (name: string, type: ColumnMetadata["type"]): ColumnMetadata => ({
  name,
  type,
  role: "linkage",
  isPayload: false,
});

const minimalTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "test",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "date_of_birth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "LN+DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    },
  ],
};

// --- coalesceSubstitutesConstant ---------------------------------------------

describe("coalesceSubstitutesConstant", () => {
  // The fallback a coalesce declares, distinctive enough that its presence in a
  // pipeline's output can only be the substitution.
  const FALLBACK = "ZZZ_FALLBACK";
  const fallbackStep = {
    function: "coalesce",
    params: { default: FALLBACK },
  };
  // One step per core function, with params that let it do its job. The values
  // below are chosen so every function that CAN empty a value does so for at
  // least one of them.
  const PARAMS: Record<string, Record<string, unknown> | undefined> = {
    substring: { start: 1, length: 3 },
    pad_left: { length: 9 },
    parse_date: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
    null_if: { values: ["EXCLUDED"] },
    replace_regex: { pattern: "[A-Z]+", replacement: "" },
    extract_regex: { pattern: "([0-9]+)" },
    filter_regex: { pattern: "^[0-9]+$" },
    split_on: { delimiter: " " },
    coalesce: { default: FALLBACK },
  };
  const stepFor = (fn: string) => ({
    function: fn,
    ...(PARAMS[fn] && { params: PARAMS[fn] }),
  });
  const VALUES = [
    "SMITH",
    "",
    "   ",
    "!!!",
    "12/31/1999",
    "EXCLUDED",
    "123",
    "Ana-Maria",
    "0",
    "a b",
  ];
  const realized = (result: ReturnType<typeof runPipeline>): string[] =>
    result === null ? [] : result instanceof Set ? [...result] : [result];

  test("the value-emptying classification matches what each function does", () => {
    // Checked against the real functions, not a reading of them: driven over the
    // value corpus, a function classified value-preserving must never return
    // null, while value-emptying needs only one witness value that does. A
    // safety check against misclassification, not a proof that no input
    // anywhere empties a preserved function's value.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES) {
      const step = stepFor(fn);
      const emptiesSomeValue = VALUES.some(
        (value) => runPipeline(value, [step]) === null,
      );
      expect(emptiesSomeValue, fn).toBe(stepCanEmptyRealizedValue(step));
    }
    // A pattern rule that erases the whole value is NOT emptying it: the coalesce
    // branch fires on a null value or an empty candidate set, and the empty string
    // is neither -- the case the name-only classification would get wrong if it
    // reasoned from "removes characters".
    expect(runPipeline("SMITH", [stepFor("replace_regex")])).toBe("");
    // A name this build does not recognize is read as able to empty a value: the
    // fail-safe direction on a consent surface, where understating a coalesce's
    // reach is the harmful one.
    expect(stepCanEmptyRealizedValue({ function: "not_a_real_function" })).toBe(
      true,
    );
  });

  test("the verdict matches whether the declared fallback is ever substituted", () => {
    // The predicate against the runtime, for every core function in front of a
    // coalesce: the fallback reaches the output exactly where the predicate says
    // the step substitutes. The coalesce is last so the constant is observable
    // rather than transformed by a later step.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES) {
      const preceding = [stepFor(fn)];
      const substituted = VALUES.some((value) =>
        realized(runPipeline(value, [...preceding, fallbackStep])).includes(
          FALLBACK,
        ),
      );
      expect(substituted, fn).toBe(
        coalesceSubstitutesConstant(fallbackStep, preceding),
      );
    }
    // As the FIRST step it substitutes for nothing: a pipeline is handed a value,
    // so the branch that substitutes is never reached.
    expect(coalesceSubstitutesConstant(fallbackStep, [])).toBe(false);
    for (const value of VALUES)
      expect(realized(runPipeline(value, [fallbackStep])), value).not.toContain(
        FALLBACK,
      );
  });

  test("a default core cannot substitute is no substitution at any position", () => {
    // Wire params are z.unknown(), so a partner can declare `default` as any JSON
    // value or omit it; every non-string runs as an absent default.
    const emptying = [stepFor("substring")];
    for (const badDefault of [null, 42, [], {}, true]) {
      const step = { function: "coalesce", params: { default: badDefault } };
      expect(
        coalesceSubstitutesConstant(step, emptying),
        JSON.stringify(badDefault),
      ).toBe(false);
    }
    expect(
      coalesceSubstitutesConstant({ function: "coalesce" }, emptying),
    ).toBe(false);
    // And no other function is ever the substituting step, whatever precedes it.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES.filter(
      (name) => name !== "coalesce",
    ))
      expect(coalesceSubstitutesConstant(stepFor(fn), emptying), fn).toBe(
        false,
      );
  });

  test("the real builder substitutes for no absent or blank field (differential)", () => {
    // The position half's assumption, held to the key builder rather than
    // asserted: a record whose field is missing or blank never reaches the
    // coalesce, so its declared fallback appears in no key string.
    // buildKeyStrings drops the row for the key when the field realizes no
    // value, and an element pipeline runs on the value the field DID realize.
    const terms: LinkageTerms = {
      version: "1.0.0",
      identity: "Party",
      date: "2025-01-01",
      algorithm: "psi",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: false },
      deduplicate: false,
      linkageFields: [{ name: "last_name", type: "last_name" }],
      linkageKeys: [
        {
          name: "LN",
          elements: [{ field: "last_name", transform: [fallbackStep] }],
        },
      ],
    };
    const rows = [{ last_name: "Smith" }, { last_name: "" }, {}];
    const dataset = buildStandardizedDataset(
      undefined,
      rows,
      inferMetadata(["last_name"]),
      terms,
    );
    const keyStrings = rows.flatMap((_, index) => [
      ...(buildKeyStrings(terms.linkageKeys[0], dataset, index) ?? []),
    ]);
    // Not vacuous: the record that holds a value does key, unsubstituted.
    expect(keyStrings.length).toBeGreaterThan(0);
    expect(keyStrings.some((key) => key.includes(FALLBACK))).toBe(false);
  });

  test("the dead-pipeline rescue reads the same verdicts through the predicate", () => {
    // pipelineAlwaysDrops shares the predicate, and its rescue is unmoved by the
    // position half: wherever it asks, the parse_date that emptied every record is
    // itself a step ahead of the coalesce.
    const dead = { function: "parse_date", params: { inputFormat: "MM/DD" } };
    expect(pipelineAlwaysDrops([dead])).toBe(true);
    expect(pipelineAlwaysDrops([dead, fallbackStep])).toBe(false);
    expect(pipelineAlwaysDrops([fallbackStep, dead])).toBe(true);
    expect(pipelineAlwaysDrops([dead, { function: "coalesce" }])).toBe(true);
    expect(
      pipelineAlwaysDrops([dead, { function: "coalesce" }, fallbackStep]),
    ).toBe(false);
    expect(pipelineAlwaysDrops([dead, fallbackStep, dead])).toBe(true);
    expect(pipelineAlwaysDrops([fallbackStep])).toBe(false);
  });
});

// --- substringCollapsesParsedDateToConstant ----------------------------------

describe("substringCollapsesParsedDateToConstant", () => {
  // The oracle corpus. Its first two dates differ in every digit of every
  // rendered component, so a window reading any date character renders
  // differently for them while one reading only the format's own characters
  // renders identically -- the property "every output is the same non-null
  // value" tests for. Wider than the probe set the predicate measures over, so
  // a probe set too narrow to discriminate fails here.
  const DATES = [
    "01/02/1971",
    "12/31/2068",
    "05/13/1990",
    "11/24/2007",
    "03/04/2021",
    "07/28/1985",
  ];
  const parseDate = (
    outputFormat: unknown,
    inputFormat: unknown = "MM/DD/YYYY",
  ): TransformStep => ({
    function: "parse_date",
    params: { inputFormat, outputFormat },
  });
  const slice = (start: unknown, length: unknown): TransformStep => ({
    function: "substring",
    params: { start, length },
  });
  // What the shipped pipeline does with the whole corpus: the value every date
  // leaves behind, or undefined where they differ or any date is dropped.
  const collapsedValue = (
    steps: ReadonlyArray<TransformStep>,
  ): string | undefined => {
    const outputs = DATES.map((date) => runPipeline(date, [...steps]));
    const first = outputs[0];
    if (typeof first !== "string") return undefined;
    return outputs.every((output) => output === first) ? first : undefined;
  };
  const verdictAt = (steps: ReadonlyArray<TransformStep>, index: number) =>
    substringCollapsesParsedDateToConstant(steps, index);
  const anyVerdict = (steps: ReadonlyArray<TransformStep>) =>
    steps.some((_step, index) => verdictAt(steps, index));

  test("the oracle corpus contains dates the predicate does not probe", () => {
    // The wider-corpus claim above, as a check: were the probe set widened to
    // the whole corpus, every differential below would compare the predicate to
    // its own inputs and pass whatever it decided.
    const probed = new Set(
      DATE_COLLAPSE_PROBES.map(
        (probe) => `${probe.month}/${probe.day}/${probe.year}`,
      ),
    );
    expect(DATES.filter((date) => !probed.has(date)).length).toBeGreaterThan(0);
  });

  test("the verdict matches whether the real slice is one constant (differential)", () => {
    // Every combination of an output format and a slice window, against the
    // shipped pipeline: the predicate says "collapses to a constant" exactly
    // where every date leaves the same non-null value behind.
    const OUTPUT_FORMATS = [
      // A literal region ahead of the date, the motivating shape.
      "ACME-YYYYMMDD",
      // Separators between the components, so a window can land on one alone.
      "YYYY-MM-DD",
      // The plain default layout, which has no literal to land in.
      "YYYYMMDD",
      // Reordered and repeated tokens: the factory substitutes EVERY occurrence,
      // so the layout contains five component spans around four literals.
      "MM-MM-YYYY-DD-DD",
      // Tokens the greedy scan must not mis-split: a fifth Y is literal after
      // YYYY, a third M is literal after MM, and a bare YY in an OUTPUT format is
      // literal text rather than a year.
      "YYYYY",
      "YYYYYY",
      "MMM",
      "MM/DD/YY",
      // No token at all -- every window is constant, the case the tokenless rule
      // already names.
      "registered",
    ];
    const WINDOWS: Array<[number, number]> = [
      [1, 1],
      [1, 4],
      [1, 5],
      [1, 6],
      [2, 3],
      [4, 2],
      [5, 1],
      [5, 2],
      [6, 1],
      [7, 2],
      [1, 40],
      [14, 3],
      [-1, 1],
      [-2, 2],
      [-4, 3],
      [-40, 2],
      // A negative length is not an empty window: it drives slice's end argument
      // below zero, where it counts back from the end of the value instead.
      [1, -3],
      [1, -9],
      [1, -13],
      [2, -8],
      [-5, -2],
    ];
    const collapsed: string[] = [];
    for (const outputFormat of OUTPUT_FORMATS)
      for (const [start, length] of WINDOWS) {
        const steps = [parseDate(outputFormat), slice(start, length)];
        const value = collapsedValue(steps);
        if (value !== undefined) collapsed.push(outputFormat);
        expect(
          verdictAt(steps, 1),
          `${outputFormat} [${start}, ${length}] -> ${JSON.stringify(value)}`,
        ).toBe(value !== undefined);
      }
    // Not vacuous, and not explained by the tokenless format alone: a layout
    // that does render the date still has windows that read none of it.
    expect(
      new Set(collapsed.filter((format) => format !== "registered")).size,
    ).toBeGreaterThan(1);
    expect(collapsed.length).toBeLessThan(
      OUTPUT_FORMATS.length * WINDOWS.length,
    );
  });

  test("a window that reads nothing is a drop, not a collapse", () => {
    // substringFactory compiles a non-integer bound, a `start` of 0, a zero
    // length, and a window that starts past the end into a step that returns null
    // for every value: the element matches NOTHING, the opposite of collapsing
    // onto a constant.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    for (const [start, length] of [
      [0, 3],
      [1, 0],
      [14, 3],
      [1, -13],
      [1.5, 3],
      [1, 2.5],
    ] as Array<[unknown, unknown]>) {
      const steps = [literalRegion, slice(start, length)];
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(verdictAt(steps, 1), `${JSON.stringify([start, length])}`).toBe(
        false,
      );
    }
    for (const bound of [null, "1", [], {}, true])
      expect(
        verdictAt([literalRegion, slice(bound, 3)], 1),
        JSON.stringify(bound),
      ).toBe(false);
  });

  test("the verdict is a property of the position, not of either step alone", () => {
    const literalRegion = parseDate("ACME-YYYYMMDD");
    const firstFour = slice(1, 4);
    expect(verdictAt([literalRegion, firstFour], 1)).toBe(true);
    // Only a substring reads a window; no other function is the sliced step.
    for (const fn of STANDARDIZATION_FUNCTION_NAMES.filter(
      (name) => name !== "substring",
    ))
      expect(verdictAt([literalRegion, { function: fn }], 1), fn).toBe(false);
    // With no parse_date ahead of it the window slices whatever the identifier
    // composed, so the layout establishes nothing.
    expect(verdictAt([firstFour], 0)).toBe(false);
    // A step BEFORE the parse_date is unconstrained: it can change whether a
    // value parses, never the layout a parsed date renders to.
    expect(
      verdictAt([{ function: "to_upper_case" }, literalRegion, firstFour], 2),
    ).toBe(true);
    // The nearest parse_date is the one that laid out the value: a plain layout
    // in front of the literal-region one does not withdraw the collapse, and the
    // reverse order does not confer it.
    expect(
      verdictAt([parseDate("YYYYMMDD"), literalRegion, firstFour], 2),
    ).toBe(true);
    expect(
      verdictAt(
        [literalRegion, parseDate("YYYYMMDD", "YYYYMMDD"), firstFour],
        2,
      ),
    ).toBe(false);
  });

  test("a parse_date that yields no value at all collapses nothing", () => {
    // An input format that core cannot assemble a date from drops every record, so
    // there is no rendered layout to slice -- a narrowing the dead-key advisory
    // reports, not a collapse. Held to the runtime as well as to the predicate.
    const firstFour = slice(1, 4);
    for (const inputFormat of ["MM/DD", 7] as unknown[]) {
      const steps = [parseDate("ACME-YYYYMMDD", inputFormat), firstFour];
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(verdictAt(steps, 1), JSON.stringify(inputFormat)).toBe(false);
    }
    // An ABSENT input format is not a dead one: the factory falls back to the
    // complete default layout, so the window still lands in the literal region.
    const absentInput = parseDate("ACME-YYYYMMDD", null);
    expect(verdictAt([absentInput, firstFour], 1)).toBe(true);
    expect(runPipeline(DATES[0], [absentInput, firstFour])).toBe("ACME");
  });

  test("an unusable output format falls back to the layout the factory renders", () => {
    // A non-string outputFormat is not text the window reads: the factory falls
    // back to the plain default layout, which has no literal region, so no window
    // collapses. Pinned against the runtime rather than the coercion's source.
    for (const outputFormat of [undefined, null, 7, [], {}] as unknown[])
      for (const [start, length] of [
        [1, 4],
        [5, 2],
        [1, 8],
        [-2, 2],
      ] as Array<[number, number]>) {
        const steps = [parseDate(outputFormat), slice(start, length)];
        expect(
          collapsedValue(steps),
          JSON.stringify(outputFormat),
        ).toBeUndefined();
        expect(verdictAt(steps, 1), JSON.stringify(outputFormat)).toBe(false);
      }
  });

  test("a run of substrings is read as the one window it ends on (differential)", () => {
    // Each link slices a contiguous range of the link before it, so a run of
    // substrings after a parse_date reads ONE window of the rendered layout. Every
    // chain below goes through the shipped pipeline: the predicate at the LAST
    // link says "collapses to a constant" exactly where every date leaves the same
    // non-null value behind, whatever the chain's intermediate windows did.
    const OUTPUT_FORMATS = [
      // The motivating shape: a literal region the composed window can land in.
      "ACME-YYYYMMDD",
      // Separators a composed window can land on alone.
      "YYYY-MM-DD",
      // No literal at all, so no chain over it may collapse.
      "YYYYMMDD",
      // No token at all, so every non-empty chain over it collapses.
      "registered",
    ];
    const CHAINS: Array<Array<[number, number]>> = [
      // A wide first window narrowed onto the literal region: neither link reads
      // only the format's own characters by itself.
      [
        [1, 13],
        [1, 4],
      ],
      [
        [1, 13],
        [2, 3],
      ],
      // The first link already lands in the literal region.
      [
        [1, 5],
        [1, 4],
      ],
      [
        [1, 5],
        [5, 1],
      ],
      // The first link straddles the literal and the date; the second retreats
      // into the literal.
      [
        [1, 6],
        [1, 4],
      ],
      // ... and the second stays on the date.
      [
        [1, 6],
        [6, 1],
      ],
      [
        [6, 8],
        [1, 4],
      ],
      // A window landing on a bare separator between two components.
      [
        [1, 10],
        [5, 1],
      ],
      [
        [5, 3],
        [1, 1],
      ],
      [
        [5, 3],
        [2, 2],
      ],
      // Negative starts, which resolve against the length the run holds at that
      // point rather than against the layout.
      [
        [-9, 9],
        [1, 4],
      ],
      [
        [1, 13],
        [-4, 2],
      ],
      // Negative lengths: an end argument below zero counts back from the end of
      // the value the link is handed, so the link reads a real window.
      [
        [1, -9],
        [1, 4],
      ],
      [
        [1, -8],
        [1, 4],
      ],
      [
        [1, 13],
        [1, -9],
      ],
      [
        [1, 5],
        [1, -4],
      ],
      // A second link reaching past the end of the first, which clamps.
      [
        [1, 4],
        [1, 10],
      ],
      // A link that reads nothing: the value is emptied and the rest of the run
      // null-propagates, so the chain drops rather than collapses.
      [
        [1, 4],
        [5, 2],
      ],
      [
        [1, 5],
        [1, 0],
      ],
      [
        [1, 5],
        [0, 3],
      ],
      // Three links.
      [
        [1, 13],
        [1, 6],
        [1, 4],
      ],
      [
        [1, 13],
        [6, 8],
        [1, 4],
      ],
      [
        [1, 13],
        [1, 5],
        [5, 1],
      ],
      [
        [1, 13],
        [1, 4],
        [5, 2],
      ],
    ];
    const collapsedBy: Array<{ outputFormat: string; links: number }> = [];
    for (const outputFormat of OUTPUT_FORMATS)
      for (const chain of CHAINS) {
        const steps = [
          parseDate(outputFormat),
          ...chain.map(([start, length]) => slice(start, length)),
        ];
        const value = collapsedValue(steps);
        if (value !== undefined)
          collapsedBy.push({ outputFormat, links: chain.length });
        // The whole element is asked, exactly as the consent header asks it: no
        // link of the run may announce a collapse the run does not deliver.
        expect(
          anyVerdict(steps),
          `${outputFormat} ${JSON.stringify(chain)} -> ${JSON.stringify(value)}`,
        ).toBe(value !== undefined);
      }
    // Not vacuous: chains collapse over more than one layout that does render a
    // date, and at both chain lengths, while plenty of them do not collapse.
    expect(
      new Set(
        collapsedBy
          .filter((c) => c.outputFormat !== "registered")
          .map((c) => c.outputFormat),
      ).size,
    ).toBeGreaterThan(1);
    expect(new Set(collapsedBy.map((c) => c.links))).toEqual(new Set([2, 3]));
    expect(collapsedBy.length).toBeLessThan(
      OUTPUT_FORMATS.length * CHAINS.length,
    );
  });

  test("the collapse verdict lands on the last link of a chain, not an earlier one", () => {
    // Neither link reads only literal characters on its own, so a rule reading
    // one window at a time would see a truncation, while the run reads "ACME"
    // out of every date. The verdict belongs to the link the run ends at.
    const steps = [parseDate("ACME-YYYYMMDD"), slice(1, 13), slice(1, 4)];
    expect(collapsedValue(steps)).toBe("ACME");
    expect(steps.map((_step, index) => verdictAt(steps, index))).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("a mid-run collapse the run then slices out of range is not announced", () => {
    // The first link reads the literal region, so a verdict taken THERE says
    // "any date"; the second link then composes out of that four-character
    // window and reads nothing, so the element matches no record at all. A
    // verdict is taken only where the run ends, which is what parts the two.
    const steps = [parseDate("ACME-YYYYMMDD"), slice(1, 4), slice(5, 2)];
    for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
    expect(steps.map((_step, index) => verdictAt(steps, index))).toEqual([
      false,
      false,
      false,
    ]);
    // The truncated element -- the same first link with nothing after it -- is
    // the collapse the mid-run verdict would have been reporting.
    expect(anyVerdict(steps.slice(0, 2))).toBe(true);
  });

  test("a value-preserving step between the two keeps the verdict", () => {
    // Each step below leaves the characters the window reads exactly where the
    // runtime leaves them, so every record still ends on one constant. A rule
    // that ended its walk at the first non-substring would call each of these a
    // truncation while the runtime collapsed -- which is the reading measuring
    // the steps replaces.
    const intervening: TransformStep[] = [
      { function: "to_upper_case" },
      { function: "to_lower_case" },
      { function: "trim_whitespace" },
      { function: "squash_spaces" },
      { function: "remove_accents" },
      { function: "remove_non_ascii" },
      { function: "remove_affixes" },
      { function: "remove_punctuation" },
      { function: "remove_dashes" },
      { function: "replace_separators_with_spaces" },
      { function: "null_if", params: { values: ["no such value"] } },
      { function: "filter_regex", params: { pattern: "ACME" } },
      { function: "coalesce", params: { default: "FALLBACK" } },
      { function: "pad_left", params: { length: 20, char: "0" } },
      { function: "replace_regex", params: { pattern: "E", replacement: "3" } },
    ];
    for (const step of intervening) {
      const steps = [parseDate("ACME-YYYYMMDD"), step, slice(1, 4)];
      expect(collapsedValue(steps), step.function).not.toBeUndefined();
      expect(verdictAt(steps, 2), step.function).toBe(true);
    }
    // Several links after the intervening step compose the same way a run
    // directly after the parse_date does.
    expect(
      verdictAt(
        [
          parseDate("ACME-YYYYMMDD"),
          { function: "remove_dashes" },
          slice(1, 12),
          slice(1, 4),
        ],
        3,
      ),
    ).toBe(true);
  });

  test("whether a step preserves the window is a property of the window too", () => {
    // Why a function-name allowlist cannot decide this. `remove_dashes` closes
    // the gap the format's own separator held, so a four-character window still
    // reads only the format's characters while a five-character one pulls the
    // year's first digit into it -- the same function, opposite verdicts.
    const dashRemoved = (start: number, length: number) => [
      parseDate("ACME-YYYYMMDD"),
      { function: "remove_dashes" },
      slice(start, length),
    ];
    expect(collapsedValue(dashRemoved(1, 4))).toBe("ACME");
    expect(verdictAt(dashRemoved(1, 4), 2)).toBe(true);
    expect(collapsedValue(dashRemoved(1, 5))).toBeUndefined();
    expect(verdictAt(dashRemoved(1, 5), 2)).toBe(false);
    // Without the step the fifth character is the format's own dash, so the
    // wider window collapses; the step is what moves the verdict, not the window
    // alone.
    expect(verdictAt([parseDate("ACME-YYYYMMDD"), slice(1, 5)], 1)).toBe(true);
  });

  test("a step that drops the collapsed value AFTER the run withholds the verdict", () => {
    // An element that matches nothing is not one that matches every date. A
    // dropping step after the run drops the constant every record holds by then,
    // which drops every record -- determinate with no probing, since there is
    // only one value left to drop.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    const neverMatches: TransformStep = {
      function: "filter_regex",
      params: { pattern: "NOTHING-MATCHES-THIS" },
    };
    const dropsTheConstant: TransformStep = {
      function: "null_if",
      params: { values: ["ACME"] },
    };
    for (const steps of [
      [literalRegion, slice(1, 4), neverMatches],
      [literalRegion, slice(1, 4), dropsTheConstant],
    ]) {
      for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
      expect(anyVerdict(steps), JSON.stringify(steps)).toBe(false);
    }
    // A `coalesce` after the drop puts every record back on one constant, so the
    // collapse stands: the tail is run, not assumed.
    const rescued = [
      literalRegion,
      slice(1, 4),
      { function: "null_if", params: { values: ["ACME"] } },
      { function: "coalesce", params: { default: "UNKNOWN" } },
    ];
    expect(collapsedValue(rescued)).toBe("UNKNOWN");
    expect(anyVerdict(rescued)).toBe(true);
    // A tail that expands the constant into candidates still keys every record,
    // and on the same values, so the collapse stands. The header never reads
    // this shape -- a declared fan-out outranks the collapse tier there -- but
    // the predicate must not call it a drop.
    const expanded = [
      literalRegion,
      slice(1, 4),
      { function: "split_on", params: { delimiter: "M" } },
    ];
    expect(runPipeline(DATES[0], expanded)).toEqual(new Set(["AC", "E"]));
    expect(anyVerdict(expanded)).toBe(true);
  });

  test("a value-dependent step that drops every probe takes the wider word", () => {
    // A drop between the parse_date and the run empties the value before the
    // window reads it; whether a real record empties there is the data's to
    // decide, so an undecided measurement resolves to the wider collapse word
    // rather than the milder truncation. The over-claim here is by design:
    // checked against the runtime, which drops every date.
    const steps = [
      parseDate("ACME-YYYYMMDD"),
      { function: "filter_regex", params: { pattern: "NOTHING-MATCHES-THIS" } },
      slice(1, 4),
    ];
    for (const date of DATES) expect(runPipeline(date, steps)).toBeNull();
    expect(anyVerdict(steps)).toBe(true);
    // The same shape spelled with the other value-dependent dropper, naming
    // every probe's rendered value outright.
    const namesEveryProbe = [
      parseDate("ACME-YYYYMMDD"),
      {
        function: "null_if",
        params: {
          values: DATES.map((date) =>
            runPipeline(date, [parseDate("ACME-YYYYMMDD")]),
          ),
        },
      },
      slice(1, 4),
    ];
    expect(anyVerdict(namesEveryProbe)).toBe(true);
  });

  test("a drop the DATA decides is the limit the verdict keeps", () => {
    // The stated limit, pinned so a change to either half is visible. A
    // `null_if` naming a rendered date no probe covers still earns "any date"
    // here, while the record holding that date is dropped rather than
    // collapsed -- reading the terms as promising otherwise would assume a drop
    // the data decides. Widening the probe set to cover this date turns this
    // red.
    const steps = [
      parseDate("ACME-YYYYMMDD"),
      { function: "null_if", params: { values: ["ACME-20330417"] } },
      slice(1, 4),
    ];
    expect(runPipeline("04/17/2033", steps)).toBeNull();
    expect(runPipeline("12/31/2068", steps)).toBe("ACME");
    expect(anyVerdict(steps)).toBe(true);
  });

  test("naming a probe's rendered value does not buy the milder word", () => {
    // The probe dates are baked into shipped public source, so an inviter can
    // read one off and author a step naming exactly its rendered value. Were a
    // dropped probe allowed to defeat the verdict, that one step would return the
    // header to the truncation word while the pipeline still put every other date
    // on "ACME". The surviving probes decide instead. The named values come from
    // the shipped probe list, so no probe here is one this test assumed.
    const literalRegion = parseDate("ACME-YYYYMMDD");
    for (const probe of DATE_COLLAPSE_PROBES) {
      const named = `ACME-${probe.year}${probe.month}${probe.day}`;
      const asInput = `${probe.month}/${probe.day}/${probe.year}`;
      const steps = [
        literalRegion,
        { function: "null_if", params: { values: [named] } },
        slice(1, 4),
      ];
      expect(runPipeline(asInput, steps), named).toBeNull();
      expect(runPipeline("03/04/2021", steps), named).toBe("ACME");
      expect(anyVerdict(steps), named).toBe(true);
    }
    // A step naming a junk sentinel no probe renders drops none of them, so the
    // verdict is measured exactly as it is without the step.
    const sentinel = [
      literalRegion,
      { function: "null_if", params: { values: ["NOT-A-RENDERED-DATE"] } },
      slice(1, 4),
    ];
    expect(collapsedValue(sentinel)).toBe("ACME");
    expect(anyVerdict(sentinel)).toBe(true);
    // ... and a dropped probe grants no collapse of its own: on a window that
    // reads the date itself, the surviving probes still disagree, so the milder
    // word stands.
    const first = DATE_COLLAPSE_PROBES[0];
    const readsTheDate = [
      literalRegion,
      {
        function: "null_if",
        params: { values: [`ACME-${first.year}${first.month}${first.day}`] },
      },
      slice(6, 8),
    ];
    expect(
      runPipeline(`${first.month}/${first.day}/${first.year}`, readsTheDate),
    ).toBeNull();
    expect(runPipeline("03/04/2021", readsTheDate)).toBe("20210304");
    expect(anyVerdict(readsTheDate)).toBe(false);
  });

  test("a run that reads no content and drops every probe is dead, not a collapse", () => {
    // The composed window falls back out of the rendered layout, and every step
    // between the parse_date and the run's end reads the layout rather than the
    // value -- so what the probes did is what every date does. That is a
    // value-INDEPENDENT drop, which pipelineAlwaysDrops reports and the collapse
    // verdict declines.
    for (const steps of [
      [parseDate("ACME-YYYYMMDD"), slice(1, 4), slice(5, 2)],
      [parseDate("ACME-YYYYMMDD"), { function: "to_upper_case" }, slice(20, 2)],
      [parseDate("YYYYMMDD"), slice(1, 4), slice(1, 0)],
    ]) {
      for (const date of DATES)
        expect(runPipeline(date, steps), JSON.stringify(steps)).toBeNull();
      expect(anyVerdict(steps), JSON.stringify(steps)).toBe(false);
      expect(pipelineAlwaysDrops(steps), JSON.stringify(steps)).toBe(true);
    }
    // A value-dependent step in the run withdraws the DEAD claim as well as the
    // milder word: the data decides that drop, so the pipeline is not reported
    // self-defeating.
    const valueDependent = [
      parseDate("ACME-YYYYMMDD"),
      { function: "filter_regex", params: { pattern: "NOTHING-MATCHES-THIS" } },
      slice(1, 4),
    ];
    expect(pipelineAlwaysDrops(valueDependent)).toBe(false);
    // A rescuing `coalesce` after the dead run puts every record on its default,
    // so the pipeline is not dead at all.
    expect(
      pipelineAlwaysDrops([
        parseDate("ACME-YYYYMMDD"),
        slice(1, 4),
        slice(5, 2),
        { function: "coalesce", params: { default: "UNKNOWN" } },
      ]),
    ).toBe(false);
  });

  test("every layout-determined function leaves the dates it is handed alike", () => {
    // A function listed here must map any two dates rendered under one output
    // format to values of the same length that are null together, checked
    // against the shipped pipeline rather than read off the factories. One
    // params shape per function, so a listed function whose content-reading only
    // shows under a different params shape is a review call documented at the
    // constant, not one this catches.
    const OUTPUT_FORMATS = [
      "ACME-YYYYMMDD",
      "YYYY-MM-DD",
      "YYYYMMDD",
      "MM/DD/YY",
      "DD.MM.YYYY",
    ];
    // Params for the listed functions that take them, chosen so the step does
    // something rather than compiling to a pass-through or an always-null.
    const PARAMS: Record<string, Array<Record<string, unknown>>> = {
      substring: [
        { start: 1, length: 4 },
        { start: 5, length: 3 },
        { start: -4, length: 2 },
        { start: 1, length: -3 },
      ],
      pad_left: [{ length: 20, char: "0" }],
      coalesce: [{ default: "FALLBACK" }],
    };
    // `coalesce` passes a value it is handed straight through, so its
    // substituting branch is reached only behind a step that empties the value.
    const PREFIX: Record<string, TransformStep[]> = {
      coalesce: [slice(40, 2)],
    };
    const WIDE_DATES = [...DATES, "02/29/2024", "10/09/1999", "01/01/2000"];
    for (const name of LAYOUT_DETERMINED_FUNCTION_NAMES) {
      expect(STANDARDIZATION_FUNCTION_NAMES, name).toContain(name);
      for (const params of PARAMS[name] ?? [undefined])
        for (const outputFormat of OUTPUT_FORMATS) {
          const steps = [
            parseDate(outputFormat),
            ...(PREFIX[name] ?? []),
            { function: name, ...(params ? { params } : {}) },
          ];
          const outputs = WIDE_DATES.map((date) => runPipeline(date, steps));
          const shape = (value: FieldValue) =>
            typeof value === "string" ? value.length : value;
          expect(
            new Set(outputs.map(shape)).size,
            `${name} ${JSON.stringify(params)} ${outputFormat}`,
          ).toBe(1);
        }
    }
  });

  test("a step this build cannot run takes the wider word, not the milder one", () => {
    // The function name is partner free text, so a name core does not recognize
    // reaches the predicate. The measurement cannot compile it, so the window's
    // breadth is unknown -- and on a consent surface an unknown breadth resolves
    // UP to the collapse word, never down to the truncation the last link looks
    // like. Were it to decline the verdict, an inviter would drop the marker from
    // "any date" to "partial" by naming one step core cannot run.
    const unknownInRun = [
      parseDate("ACME-YYYYMMDD"),
      { function: "no_such_function" },
      slice(1, 4),
    ];
    expect(() => runPipeline(DATES[0], unknownInRun)).toThrow(
      UnknownStandardizationFunctionError,
    );
    expect(anyVerdict(unknownInRun)).toBe(true);
    // The same, with the unrecognized step in the TAIL after a run that already
    // collapsed to one constant: the collapse stands rather than falling to the
    // milder word because the tail could not be measured.
    const unknownInTail = [
      parseDate("ACME-YYYYMMDD"),
      slice(1, 4),
      { function: "no_such_function" },
    ];
    expect(verdictAt(unknownInTail, 1)).toBe(true);
  });

  test("a probe inflated past the value ceiling takes the wider word", () => {
    // A replace_regex can expand a probe date past the per-value ceiling, so the
    // measured run returns "unread" before it reads the window. The consent
    // marker must resolve that up to the collapse word rather than the milder
    // "pattern replacement" name, since a real date still collapses onto one
    // constant while this one probe went unmeasured. 5000 fill characters push
    // the rendered probe past the 4096-character ceiling.
    const inflated = [
      parseDate("ACME-YYYYMMDD"),
      {
        function: "replace_regex",
        params: { pattern: "ACME", replacement: "X".repeat(5000) },
      },
      slice(1, 4),
    ];
    // Every date really does collapse onto one constant here -- the slice reads
    // fill the replacement supplied -- which is the breadth the marker must name.
    // runPipeline does not enforce the ceiling (the exchange path does, and would
    // refuse the over-length intermediate), so the collapse is visible directly.
    for (const date of DATES) expect(runPipeline(date, inflated)).toBe("XXXX");
    expect(anyVerdict(inflated)).toBe(true);
    // A run measured clean still keeps its true milder word: a plain slice of the
    // date itself reads distinct values across the probes, so the verdict declines
    // the collapse and the header shows "partial" (see the differential above).
    const cleanPartial = [parseDate("YYYYMMDD"), slice(1, 4)];
    expect(collapsedValue(cleanPartial)).toBeUndefined();
    expect(anyVerdict(cleanPartial)).toBe(false);
  });
});

// --- CONSENT_VERDICT_PARAM_NAMES ---------------------------------------------

describe("CONSENT_VERDICT_PARAM_NAMES", () => {
  // What holds the table to real verdicts: every param it lists is moved here,
  // and the predicate that reads it must move with it. The cases are driven from
  // the shipped constant, so a name added there without one is a failure rather
  // than a silently unheld entry. The other direction -- a NEW verdict param
  // arriving with no entry in the constant -- no test can see; it is the review
  // call the constant's own doc records.
  const parseDate = (outputFormat: string): TransformStep => ({
    function: "parse_date",
    params: { inputFormat: "MM/DD/YYYY", outputFormat },
  });
  const slicedLiteralRegion = (
    outputFormat: string,
    start: number,
    length: number,
  ): boolean =>
    substringCollapsesParsedDateToConstant(
      [
        parseDate(outputFormat),
        { function: "substring", params: { start, length } },
      ],
      1,
    );
  const emptyingStep: TransformStep = {
    function: "null_if",
    params: { values: ["ACME"] },
  };
  const coalesceWithDefault = (declared: unknown): boolean =>
    coalesceSubstitutesConstant(
      { function: "coalesce", params: { default: declared } },
      [emptyingStep],
    );

  // Each case declares two values for its param whose verdicts must differ.
  const VERDICT_MOVES: Record<
    string,
    Record<string, () => [boolean, boolean]>
  > = {
    parse_date: {
      inputFormat: () => [
        parseDateInputDropsEveryRecord({ inputFormat: "MM/DD" }),
        parseDateInputDropsEveryRecord({ inputFormat: "MM/DD/YYYY" }),
      ],
      outputFormat: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("YYYYMMDD", 1, 4),
      ],
    },
    substring: {
      start: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("ACME-YYYYMMDD", 6, 4),
      ],
      length: () => [
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 4),
        slicedLiteralRegion("ACME-YYYYMMDD", 1, 6),
      ],
    },
    coalesce: {
      default: () => [
        coalesceWithDefault("SUBSTITUTED"),
        coalesceWithDefault(7),
      ],
    },
  };

  test("every listed param moves the verdict that reads it", () => {
    expect(Object.keys(VERDICT_MOVES).sort()).toEqual(
      Object.keys(CONSENT_VERDICT_PARAM_NAMES).sort(),
    );
    for (const [functionName, params] of Object.entries(
      CONSENT_VERDICT_PARAM_NAMES,
    )) {
      const moves = VERDICT_MOVES[functionName];
      expect(Object.keys(moves).sort(), functionName).toEqual(
        [...params].sort(),
      );
      for (const [param, move] of Object.entries(moves))
        expect(move(), `${functionName}.${param}`).toEqual([true, false]);
    }
  });
});

// --- pipelineAlwaysDrops rescue equivalence ----------------------------------

describe("pipelineAlwaysDrops rescue equivalence", () => {
  // pipelineAlwaysDrops rescues a dropped value through the shared predicate;
  // every rescue this sweep reaches already has an emptying step ahead of it.
  // Checked here: the shipped function against a rescue testing only the
  // declared default, over every pipeline the alphabet below spells, reporting
  // a differing verdict -- including a function wrongly allowlisted for
  // setting `dropped`, which would silently turn a live pipeline dead. (The
  // reverse misclassification is the value-emptying test's to catch.)
  const FALLBACK_DEFAULT = "ZZZ_FALLBACK";

  // The rescue with no position half: the declared default's shape alone. The
  // rescue is what this compares, so the DROP sources are held equal -- the
  // measured substring run and the degenerate declared window are asked of core,
  // whose readings of them are not what is under test, while the rest is a local
  // transcription rather than a call into the shipped predicate, which would
  // compare it to itself.
  const dropsUnderDefaultShapeRescue = (
    steps: ReadonlyArray<TransformStep>,
  ): boolean => {
    let dropped = false;
    for (const [index, step] of steps.entries()) {
      if (step.function === "coalesce") {
        if (dropped && typeof step.params?.default === "string")
          dropped = false;
        continue;
      }
      if (dropped) continue;
      if (
        (step.function === "parse_date" &&
          parseDateInputDropsEveryRecord(step.params)) ||
        (step.function === "substring" &&
          substringWindowDropsEveryValue(step.params)) ||
        substringRunDropsEveryParsedDate(steps, index)
      )
        dropped = true;
    }
    return dropped;
  };

  // Every function core knows, bare, plus the parse_date and coalesce shapes the
  // two formulations turn on: a wire step's params are z.unknown(), so the
  // non-string and null spellings are reachable from a partner's terms.
  const ALPHABET: ReadonlyArray<TransformStep> = [
    ...STANDARDIZATION_FUNCTION_NAMES.map((fn) => ({ function: fn })),
    { function: "parse_date", params: {} },
    { function: "parse_date", params: { inputFormat: "MM/DD" } },
    { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
    { function: "parse_date", params: { inputFormat: null } },
    { function: "parse_date", params: { inputFormat: 42 } },
    { function: "coalesce", params: {} },
    { function: "coalesce", params: { default: FALLBACK_DEFAULT } },
    { function: "coalesce", params: { default: 42 } },
    { function: "coalesce", params: { default: null } },
    { function: "not_a_real_function" },
  ];
  const MAX_PIPELINE_LENGTH = 4;

  const forEachPipeline = (
    visit: (pipeline: TransformStep[]) => void,
  ): void => {
    const extend = (prefix: TransformStep[]): void => {
      if (prefix.length === MAX_PIPELINE_LENGTH) return;
      for (const step of ALPHABET) {
        const pipeline = [...prefix, step];
        visit(pipeline);
        extend(pipeline);
      }
    };
    extend([]);
  };

  test("the position half withholds no rescue the prior formulation makes", () => {
    const divergent: string[] = [];
    let examined = 0;
    let deadVerdicts = 0;
    forEachPipeline((pipeline) => {
      examined += 1;
      const drops = pipelineAlwaysDrops(pipeline);
      if (drops) deadVerdicts += 1;
      if (drops !== dropsUnderDefaultShapeRescue(pipeline))
        divergent.push(JSON.stringify(pipeline));
    });
    // Two assertions so a failure includes witnesses as well as its scale: the
    // whole divergent list is elided in the diff once it runs to thousands.
    expect(divergent.slice(0, 3)).toEqual([]);
    expect(divergent).toHaveLength(0);
    // Not vacuous: the sweep is the full enumeration and reaches both verdicts.
    const enumeratedPipelines = Array.from(
      { length: MAX_PIPELINE_LENGTH },
      (_, index) => ALPHABET.length ** (index + 1),
    ).reduce((total, count) => total + count, 0);
    expect(examined).toBe(enumeratedPipelines);
    expect(deadVerdicts).toBeGreaterThan(0);
    expect(deadVerdicts).toBeLessThan(examined);
  });
});

// --- validateStandardizationAgainstTerms -------------------------------------

describe("validateStandardizationAgainstTerms", () => {
  test("valid standardization returns no errors", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(
      validateStandardizationAgainstTerms(standardization, minimalTerms),
    ).toEqual([]);
  });

  test("unknown output field is reported", () => {
    const standardization = [{ output: "nonexistent_field", input: "X" }];
    const errors = validateStandardizationAgainstTerms(
      standardization,
      minimalTerms,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/nonexistent_field/);
  });

  test("unknown function name is reported", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "does_not_exist" }],
      },
    ];
    const errors = validateStandardizationAgainstTerms(
      standardization,
      minimalTerms,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does_not_exist/);
  });

  test("coalesce is not reported as unknown", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "coalesce", params: { default: "UNKNOWN" } }],
      },
    ];
    expect(
      validateStandardizationAgainstTerms(standardization, minimalTerms),
    ).toEqual([]);
  });

  // The output/function names are interpolated raw into the returned messages;
  // a control character in a name must reach the operator only in its escaped
  // form, and that escape happens once, where the error is rendered. Asserted
  // on the RENDERED text, never the raw message -- a raw assertion would pass
  // equally on a value escaped twice. ASCII-only names are a no-op for the
  // escape, so only these two control-character cases pin it.
  const renderedRefusal = (
    standardization: Standardization,
    terms: LinkageTerms,
  ): string =>
    sanitizeErrorForDisplay(
      ((): unknown => {
        try {
          assertStandardizationMatchesTerms(standardization, terms);
        } catch (err) {
          return err;
        }
        throw new Error("expected assertStandardizationMatchesTerms to throw");
      })(),
    );

  test("an output name with a control character is escaped in the message", () => {
    const raw = "last\u0000name"; // a null byte; not a declared field name
    const rendered = renderedRefusal(
      [{ output: raw, input: "X" }],
      minimalTerms,
    );
    // The membership test used the raw value (so it was correctly flagged), but
    // the operator sees only the escaped form, never the raw control character.
    expect(rendered).not.toContain(raw);
    expect(rendered).toContain(sanitizeForDisplay(raw));
  });

  test("an unknown function name with a control character is escaped in the message", () => {
    const raw = "bad\u0000fn"; // a null byte; not a known function name
    const rendered = renderedRefusal(
      [{ output: "last_name", input: "LN", steps: [{ function: raw }] }],
      minimalTerms,
    );
    expect(rendered).not.toContain(raw);
    expect(rendered).toContain(sanitizeForDisplay(raw));
  });

  // The reachability the OperatorConfigError doc rests on: the accept side
  // derives its standardization from the partner-authored adopted terms via
  // getDefaultStandardization, whose outputs are exactly those terms' field
  // names, so the derived spec is consistent with the terms by construction --
  // this fail-closed error is unreachable on the accept side. Pinned with a
  // hostile field name that would be alarming if it ever reached the operator.
  test("getDefaultStandardization is consistent with the terms it derives from, even for a hostile field name", () => {
    const hostileName = "call 1-800-EVIL now";
    const hostileTerms: LinkageTerms = {
      ...minimalTerms,
      linkageFields: [{ name: hostileName, type: "first_name" }],
      linkageKeys: [{ name: "k", elements: [{ field: hostileName }] }],
    };
    const md: Metadata = [
      { name: "c", type: "first_name", role: "linkage", isPayload: false },
    ];
    const std = getDefaultStandardization(md, hostileTerms);
    expect(validateStandardizationAgainstTerms(std, hostileTerms)).toEqual([]);
  });
});

describe("assertStandardizationMatchesTerms", () => {
  test("throws StandardizationTermsError, holding the inconsistency, on a contradiction", () => {
    const standardization = [{ output: "nonexistent_field", input: "X" }];
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).toThrow(StandardizationTermsError);
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).toThrow(/nonexistent_field/);
  });

  test("is a no-op on a standardization consistent with its terms", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(() =>
      assertStandardizationMatchesTerms(standardization, minimalTerms),
    ).not.toThrow();
  });
});

describe("assertFanOutImplemented", () => {
  const fanOutStep = { function: "split_on", params: { delimiter: "-" } };
  const elementFanOutKeys: LinkageTerms["linkageKeys"] = [
    {
      name: "LN+DOB",
      elements: [
        { field: "last_name", transform: [fanOutStep] },
        { field: "date_of_birth" },
      ],
    },
  ];

  test("refuses a standardization declaring a fan-out step, naming it", () => {
    // A standardization is only ever this party's own -- no invitation holds
    // one, and the derived default declares no fan-out step -- so the refusal
    // is an OperatorConfigError, which both front ends report as the
    // actionable config category.
    const standardization = [
      { output: "last_name", input: "LN", steps: [fanOutStep] },
    ];
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).toThrow(OperatorConfigError);
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).toThrow(/split_on/);
  });

  test("refuses a linkage-key element transform declaring a fan-out step", () => {
    // The element transform is adopted verbatim from the partner's invitation on
    // the accept path, so this half stays a plain UsageError: not provably this
    // operator's own content, and its message stays swallowed by the generic
    // alert.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: elementFanOutKeys,
    };
    expect(() => assertFanOutImplemented(terms)).toThrow(UsageError);
    expect(() => assertFanOutImplemented(terms)).toThrow(/split_on/);
    expect(() => assertFanOutImplemented(terms)).not.toThrow(
      OperatorConfigError,
    );
  });

  test("admits both authoring surfaces under single-pass, the strategy that matches a candidate set", () => {
    // The narrowed rule's other half: fan-out matching is specified for
    // single-pass alone (docs/spec/PROTOCOL.md, Fan-out runs under single-pass
    // only), so the same two configurations the cascade refuses above run there.
    const singlePassTerms: LinkageTerms = {
      ...minimalTerms,
      linkageStrategy: "single-pass",
    };
    const standardization = [
      { output: "last_name", input: "LN", steps: [fanOutStep] },
    ];
    expect(() =>
      assertFanOutImplemented(singlePassTerms, standardization),
    ).not.toThrow();
    expect(() =>
      assertFanOutImplemented({
        ...singlePassTerms,
        linkageKeys: elementFanOutKeys,
      }),
    ).not.toThrow();
  });

  test("refuses a strategy this build does not recognize, rather than admitting it", () => {
    // An allowlist, not a cascade-named denylist: a strategy added to the schema
    // refuses a fan-out until it too realizes one. Cast because no such member
    // exists yet -- which is the case this pins.
    const futureStrategyTerms = {
      ...minimalTerms,
      linkageStrategy: "two-pass",
      linkageKeys: elementFanOutKeys,
    } as unknown as LinkageTerms;
    expect(() => assertFanOutImplemented(futureStrategyTerms)).toThrow(
      UsageError,
    );
  });

  test("the refusal names the strategy rule and the two ways out of it", () => {
    // What an operator does about it: agree single-pass terms, or drop the step.
    // Neither remedy is derivable from the function name alone, so both are
    // pinned rather than left to the message's shape.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: elementFanOutKeys,
    };
    expect(() => assertFanOutImplemented(terms)).toThrow(/single-pass/);
    expect(() => assertFanOutImplemented(terms)).toThrow(
      /Agree linkage terms whose linkage_strategy is single-pass/,
    );
    expect(() => assertFanOutImplemented(terms)).toThrow(
      /remove the "split_on" step/,
    );
  });

  test("covers every function that fans out, not the literal split_on alone", () => {
    // The refusal reads FAN_OUT_FUNCTION_NAMES, so a fan-out function added there
    // is refused with no second edit here.
    for (const name of FAN_OUT_FUNCTION_NAMES) {
      const standardization = [
        { output: "last_name", input: "LN", steps: [{ function: name }] },
      ];
      expect(() =>
        assertFanOutImplemented(minimalTerms, standardization),
      ).toThrow(UsageError);
    }
  });

  test("is a no-op on transforms that declare no fan-out step", () => {
    const standardization = [
      {
        output: "last_name",
        input: "LN",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    expect(() =>
      assertFanOutImplemented(minimalTerms, standardization),
    ).not.toThrow();
    expect(() => assertFanOutImplemented(minimalTerms)).not.toThrow();
  });
});

// --- assertTransformsCompile -------------------------------------------------

describe("assertTransformsCompile", () => {
  // Every shape a factory refuses at compile: an absent required param, a param
  // the factory checks past its type, an unimplemented enum member, and a
  // function name outside the registry. Each parses as linkage terms -- transform
  // params are z.unknown() on the wire schema -- so this assert is what stands
  // between them and a run that aborts on the first key.
  const uncompilableSteps = [
    { function: "pad_left", params: {} },
    { function: "pad_left", params: { length: 4, char: "ab" } },
    { function: "phonetic", params: { algorithm: "metaphone" } },
    { function: "no_such_function", params: {} },
  ];

  const keysWithTransform = (
    steps: TransformStep[],
  ): LinkageTerms["linkageKeys"] => [
    {
      name: "LN+DOB",
      elements: [
        { field: "last_name", transform: steps },
        { field: "date_of_birth" },
      ],
    },
  ];

  test("the steps it refuses are ones the terms schema admits", () => {
    // The gap this assert closes, asserted rather than claimed: a transform
    // param is z.unknown() on the wire schema, so every step above rides an
    // invitation that parses and is caught nowhere until the pipeline is built.
    for (const step of uncompilableSteps) {
      const parsed = safeParseLinkageTerms({
        ...minimalTerms,
        linkageKeys: keysWithTransform([step]),
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("refuses each uncompilable step in a standardization, naming the function", () => {
    // A standardization is only ever this party's own, so the refusal is an
    // OperatorConfigError -- the actionable config category both front ends key
    // off, the same split assertFanOutImplemented keeps.
    for (const step of uncompilableSteps) {
      const standardization = [
        { output: "last_name", input: "LN", steps: [step] },
      ];
      expect(() =>
        assertTransformsCompile(minimalTerms, standardization),
      ).toThrow(OperatorConfigError);
    }
    expect(() =>
      assertTransformsCompile(minimalTerms, [
        { output: "last_name", input: "LN", steps: [uncompilableSteps[0]] },
      ]),
    ).toThrow(/"pad_left"/);
  });

  test("refuses each uncompilable step in a key element transform", () => {
    // The element transform is adopted verbatim from a partner's invitation on
    // the accept path, so this half stays a plain UsageError.
    for (const step of uncompilableSteps) {
      const terms: LinkageTerms = {
        ...minimalTerms,
        linkageKeys: keysWithTransform([step]),
      };
      expect(() => assertTransformsCompile(terms)).toThrow(UsageError);
      expect(() => assertTransformsCompile(terms)).not.toThrow(
        OperatorConfigError,
      );
    }
  });

  test("narrows a function name the build does not recognize out of the message", () => {
    // An element transform's `function` is partner-authored free text, so it is
    // never echoed: a name outside the registry reaches the message as a fixed
    // literal instead.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform([
        { function: "ZZ_PARTNER_CHOSEN_NAME", params: {} },
      ]),
    };
    expect(() => assertTransformsCompile(terms)).toThrow(
      /a function this build does not recognize/,
    );
    expect(() => assertTransformsCompile(terms)).not.toThrow(
      /ZZ_PARTNER_CHOSEN_NAME/,
    );
  });

  test("states the two remedies the author still holds, not a renegotiation", () => {
    // The refusal is raised only where the party still holds the document, so
    // its remedy is an edit -- never the out-of-band renegotiation the run
    // boundary can offer once an invitation has gone out.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform([uncompilableSteps[0]]),
    };
    expect(() => assertTransformsCompile(terms)).toThrow(
      /Correct that step's parameters, or remove the step\./,
    );
  });

  test("names the FIRST uncompilable step of a pipeline, not a later one", () => {
    // Each step is compiled alone, so the one reported is the one an author
    // reaches first rather than whichever the pipeline compile happened to hit.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform([
        { function: "to_upper_case" },
        { function: "pad_left", params: {} },
        { function: "phonetic", params: { algorithm: "metaphone" } },
      ]),
    };
    expect(() => assertTransformsCompile(terms)).toThrow(/"pad_left"/);
  });

  test("refuses every Object.prototype name on both surfaces", () => {
    // The registry is read by an own-property lookup, so a name that reaches
    // only Object.prototype is a name this build does not recognize. Under a
    // bare index `constructor` and `toString` answer with an inherited member,
    // which is not a factory: the step compiles to a non-callable, is admitted
    // here, and throws at the first row -- after the invitation was accepted,
    // the abort this check exists to prevent. Held over the whole prototype
    // rather than those two names, so a future engine's addition is covered.
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      const step = { function: name, params: {} };
      const terms: LinkageTerms = {
        ...minimalTerms,
        linkageKeys: keysWithTransform([step]),
      };
      expect(() => assertTransformsCompile(terms), name).toThrow(UsageError);
      expect(() => assertTransformsCompile(terms), name).toThrow(
        /a function this build does not recognize/,
      );
      expect(
        () =>
          assertTransformsCompile(minimalTerms, [
            { output: "last_name", input: "LN", steps: [step] },
          ]),
        name,
      ).toThrow(OperatorConfigError);
      // The run's own compile agrees, so the mint refuses what the run would
      // refuse rather than what it would crash on.
      expect(() => compileSteps([step]), name).toThrow(
        UnknownStandardizationFunctionError,
      );
    }
  });

  test("admits a pipeline every step of which compiles, both surfaces", () => {
    // Not vacuous: the well-formed counterparts of the refused steps above, plus
    // a substring window that reads nothing -- which compiles, and is graded dead
    // by decideLinkageTermsVerdict rather than refused here.
    const compilable: TransformStep[] = [
      { function: "to_upper_case" },
      { function: "pad_left", params: { length: 9, char: "0" } },
      { function: "phonetic", params: { algorithm: "soundex" } },
      { function: "substring", params: {} },
    ];
    expect(() =>
      assertTransformsCompile(
        { ...minimalTerms, linkageKeys: keysWithTransform(compilable) },
        [{ output: "last_name", input: "LN", steps: compilable }],
      ),
    ).not.toThrow();
    expect(() => assertTransformsCompile(minimalTerms)).not.toThrow();
  });

  test("refuses closed on each surface when the compile budget runs out", () => {
    // The walk cannot be interrupted mid-compile, so it checks the clock between
    // steps and refuses what it has not checked -- the shape the dialect walk
    // takes. Each surface keeps its own error class through the exhaustion path.
    const compilable: TransformStep[] = [
      { function: "pad_left", params: { length: 9, char: "0" } },
    ];
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform(compilable),
    };
    expect(() =>
      assertTransformsCompile(
        terms,
        [{ output: "last_name", input: "LN", steps: compilable }],
        { totalBudgetMs: 0 },
      ),
    ).toThrow(OperatorConfigError);
    expect(() =>
      assertTransformsCompile(terms, undefined, { totalBudgetMs: 0 }),
    ).toThrow(UsageError);
    expect(() =>
      assertTransformsCompile(terms, undefined, { totalBudgetMs: 0 }),
    ).toThrow(/did not finish within the 0 ms allowed/);
    // Not vacuous: the same terms pass under the budget the mint runs with.
    expect(() => assertTransformsCompile(terms)).not.toThrow();
  });

  test("a walk the budget stops commits none of what it compiled", () => {
    // What the walk compiled before the budget was spent is dropped, so the
    // next walk over the same document starts where this one did rather than
    // resuming past what it paid for -- which is what let the same document be
    // refused over and over and then admitted with nothing edited. The formats
    // are unique to this test so the engine's own pattern cache is cold here.
    const elements: LinkageKeyElement[] = Array.from(
      { length: 32 },
      (_, index) => ({
        field: "last_name",
        transform: [
          {
            function: "parse_date",
            params: {
              inputFormat: `BUDGET-${index}-${"MM/DD/YYYY".repeat(26)}`.slice(
                0,
                256,
              ),
            },
          },
        ],
      }),
    );
    const memoized = (): number =>
      elements.filter((element) =>
        hasMemoizedCompiledSteps(element.transform as TransformStep[]),
      ).length;
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: [{ name: "LN", elements }],
    };
    expect(() =>
      assertTransformsCompile(terms, undefined, { totalBudgetMs: 1 }),
    ).toThrow(/did not finish within the 1 ms allowed/);
    expect(memoized()).toBe(0);
    // Not vacuous: a walk that reaches the end does commit what it compiled,
    // which is what makes a repeated mint of one document pay for it once.
    expect(() => assertTransformsCompile(terms)).not.toThrow();
    expect(memoized()).toBe(elements.length);
  });

  test("refuses a document over the count bound on every mint", () => {
    // The count bound is the deterministic half: the same document declares the
    // same steps whatever the machine or the attempt, so a mint repeated after
    // no edit gets the same refusal rather than eventually going through.
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform(
        Array.from({ length: 5 }, () => ({ function: "to_upper_case" })),
      ),
    };
    for (let attempt = 0; attempt < 20; attempt += 1)
      expect(
        () => assertTransformsCompile(terms, undefined, { maxSteps: 4 }),
        `attempt ${attempt}`,
      ).toThrow(/5 steps, against a limit of 4/);
  });

  test("refuses a document declaring more steps than the count bound", () => {
    // The deterministic bound the budget cannot be: a count of what the
    // document declares, answered before anything compiles, so the same
    // document gets the same answer on any machine. Each surface keeps the
    // error class it keeps for the compile refusals, by whose content the
    // fault is.
    const steps = (count: number): TransformStep[] =>
      Array.from({ length: count }, () => ({ function: "to_upper_case" }));
    const overCount: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform(steps(5)),
    };
    expect(() =>
      assertTransformsCompile(overCount, undefined, { maxSteps: 4 }),
    ).toThrow(UsageError);
    expect(() =>
      assertTransformsCompile(overCount, undefined, { maxSteps: 4 }),
    ).toThrow(/5 steps, against a limit of 4/);
    expect(() =>
      assertTransformsCompile(
        minimalTerms,
        [{ output: "last_name", input: "LN", steps: steps(5) }],
        { maxSteps: 4 },
      ),
    ).toThrow(OperatorConfigError);
    // The two surfaces are counted together, and the class follows the one
    // whose steps take the total past the bound.
    expect(() =>
      assertTransformsCompile(
        { ...minimalTerms, linkageKeys: keysWithTransform(steps(3)) },
        [{ output: "last_name", input: "LN", steps: steps(3) }],
        { maxSteps: 4 },
      ),
    ).toThrow(UsageError);
    // Refused on the count alone, before a step is compiled: an uncompilable
    // step in an over-count document is not what the message names.
    expect(() =>
      assertTransformsCompile(
        { ...minimalTerms, linkageKeys: keysWithTransform(steps(4)) },
        [
          {
            output: "last_name",
            input: "LN",
            steps: [uncompilableSteps[0], ...steps(1)],
          },
        ],
        { maxSteps: 4 },
      ),
    ).toThrow(/6 steps, against a limit of 4/);
    // Not vacuous: the same shapes pass under the bound the mint runs with.
    expect(() => assertTransformsCompile(overCount)).not.toThrow();
  });

  test("compiles a document's transforms once across repeated checks", () => {
    // The check shares the run's compile memo, which is what lets a mint that
    // repeats -- a retried Generate, an exchange file saved after the code --
    // cost nothing the first one already paid. Measured rather than claimed:
    // each step below compiles a pattern of its own, so a second uncached walk
    // would cost what the first did.
    const distinctSteps = (count: number): TransformStep[] =>
      Array.from({ length: count }, (_, index) => ({
        function: "parse_date",
        params: {
          inputFormat: `-${index}-${"MM/DD/YYYY".repeat(26)}`.slice(0, 256),
        },
      }));
    const terms: LinkageTerms = {
      ...minimalTerms,
      linkageKeys: keysWithTransform(distinctSteps(512)),
    };
    const elapsed = (run: () => void): number => {
      const startedAt = performance.now();
      run();
      return performance.now() - startedAt;
    };
    const first = elapsed(() => {
      assertTransformsCompile(terms);
    });
    const second = elapsed(() => {
      assertTransformsCompile(terms);
    });
    expect(second * 10).toBeLessThan(first);
  });
});

// --- unsatisfiedLinkageFields ------------------------------------------------

// Fixture: columns that cover first_name, last_name, date_of_birth, ssn.
const FULL_COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const fullTerms = getDefaultLinkageTerms(
  "Agency A",
  inferMetadata(FULL_COLUMNS),
);

describe("unsatisfiedLinkageFields", () => {
  test("names the fields whose type no input column provides", () => {
    const unsatisfied = unsatisfiedLinkageFields(["first_name"], fullTerms);
    const names = unsatisfied.map((f) => f.name).sort();
    expect(names).toContain("last_name");
    expect(names).toContain("date_of_birth");
    expect(names).toContain("ssn");
    expect(names).not.toContain("first_name");
  });

  test("a column of the right type but different name still satisfies", () => {
    // `fname` and `dob` are aliases inferred as first_name / date_of_birth.
    const unsatisfied = unsatisfiedLinkageFields(
      ["fname", "lname", "dob", "ssn"],
      fullTerms,
    );
    expect(unsatisfied).toEqual([]);
  });

  test("an explicit standardization mapping a present role:linkage column satisfies a field its type does not", () => {
    // `tax_id` is not inferred as ssn; an explicit mapping makes it so, but only
    // when the column is roled `linkage`. With name-inferred metadata `tax_id`
    // infers as `role: identifier`, so the mapping is refused (role wins) and ssn
    // stays unsatisfiable; roling it `linkage` in explicit metadata satisfies it.
    const columns = ["first_name", "last_name", "dob", "tax_id"];
    expect(
      unsatisfiedLinkageFields(columns, fullTerms, [
        { output: "ssn", input: "tax_id" },
      ]).map((f) => f.name),
    ).toContain("ssn");
    expect(
      unsatisfiedLinkageFields(
        columns,
        fullTerms,
        [{ output: "ssn", input: "tax_id" }],
        [
          {
            name: "first_name",
            type: "first_name",
            role: "linkage",
            isPayload: false,
          },
          {
            name: "last_name",
            type: "last_name",
            role: "linkage",
            isPayload: false,
          },
          {
            name: "dob",
            type: "date_of_birth",
            role: "linkage",
            isPayload: false,
          },
          { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
        ],
      ),
    ).toEqual([]);
  });

  test("an explicit standardization with an absent input preempts the type fallback", () => {
    // The config maps ssn from `tax_id` (absent) even though an `ssn` column is
    // present. The explicit mapping preempts the type fallback, so ssn is still
    // unsatisfiable -- the exchange would bind it to the missing column.
    const unsatisfied = unsatisfiedLinkageFields(
      ["first_name", "last_name", "dob", "ssn"],
      fullTerms,
      [{ output: "ssn", input: "tax_id" }],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("explicit metadata types the fallback, satisfying a field a column name would not infer", () => {
    // `tax_id` does not infer to ssn, but the config's metadata types it as ssn --
    // the exchange resolves the type fallback against that metadata, so ssn is
    // producible.
    const columns = ["first_name", "last_name", "dob", "tax_id"];
    expect(
      unsatisfiedLinkageFields(columns, fullTerms, undefined, [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
      ]),
    ).toEqual([]);
  });

  test("explicit metadata that retypes a present column away makes its field unsatisfiable", () => {
    // The `ssn` column would infer to ssn, but the config retypes it to `other`, so
    // the exchange produces no ssn values; the check follows the metadata, not the
    // name, and reports ssn unsatisfiable.
    const columns = ["first_name", "last_name", "dob", "ssn"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "ssn", type: "other", role: "payload", isPayload: true },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("metadata declaring a column absent from the input does not count as coverage", () => {
    // The metadata describes an `ssn` column, but the actual input lacks it (a CSV
    // swapped since the config was written). The exchange would read no values for
    // that column, so the type fallback must not treat ssn as covered -- the present
    // restriction is what prevents stale metadata from masking the gap.
    const columns = ["first_name", "last_name", "dob"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });

  test("an absent same-typed metadata column ordered before a present one is unsatisfiable", () => {
    // Two ssn-typed columns, the absent one listed first. The exchange binds the
    // field to the FIRST match (getDefaultStandardization / buildStandardizedDataset
    // both use metadata.find) and reads that absent column, producing nothing -- so
    // the check must follow the same first-match selection and not merely ask whether
    // any same-typed column is present.
    const columns = ["first_name", "last_name", "dob", "present_ssn"];
    const unsatisfied = unsatisfiedLinkageFields(
      columns,
      fullTerms,
      undefined,
      [
        {
          name: "first_name",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "last_name",
          type: "last_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "dob",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
        { name: "absent_ssn", type: "ssn", role: "linkage", isPayload: false },
        { name: "present_ssn", type: "ssn", role: "linkage", isPayload: false },
      ],
    );
    expect(unsatisfied.map((f) => f.name)).toContain("ssn");
  });
});

describe("assessLinkageSatisfiability", () => {
  test("a full input satisfies every field and every key", () => {
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      fullTerms,
    );
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(fullTerms.linkageKeys.length);
  });

  test("an input covering no complete key reports zero satisfiable keys", () => {
    // Only first_name is present. Every default key has at least one other
    // required field (ssn, last_name, or date_of_birth), so no key can match.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["first_name"],
      fullTerms,
    );
    expect(satisfiableKeyCount).toBe(0);
    const names = unsatisfied.map((f) => f.name);
    expect(names).toContain("ssn");
    expect(names).toContain("last_name");
    expect(names).toContain("date_of_birth");
  });

  test("an input missing one field keeps the keys that do not need it", () => {
    // No ssn column, but first/last name and dob are present. Keys that require
    // ssn become unsatisfiable; the name+dob keys survive, so the count is
    // positive but short of the declared total.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["last_name", "first_name", "dob"],
      fullTerms,
    );
    expect(unsatisfied.map((f) => f.name)).toEqual(["ssn"]);
    expect(satisfiableKeyCount).toBeGreaterThan(0);
    expect(satisfiableKeyCount).toBeLessThan(fullTerms.linkageKeys.length);
  });

  // Built without metadata so it keeps every default key -- including the ssn4
  // keys and the swap key -- that the type-filtered `fullTerms` fixture drops.
  const allKeyTerms = getDefaultLinkageTerms("Agency A");

  test("an ssn column does not satisfy an ssn4 field (distinct semantic types)", () => {
    // The full default terms reference both ssn and ssn4. An `ssn` column infers
    // as ssn only, never ssn4, so ssn4 stays unsatisfiable -- matching runtime,
    // where the absence of an ssn4-typed column collapses the ssn4 keys.
    const { unsatisfied } = assessLinkageSatisfiability(
      ["first_name", "last_name", "dob", "ssn"],
      allKeyTerms,
    );
    const names = unsatisfied.map((f) => f.name);
    expect(names).toContain("ssn4");
    expect(names).not.toContain("ssn");
  });

  test("a swap key is assessed by its element fields, so an absent swapped field excludes it", () => {
    // The default terms include "swap(LN, FN) + DOB". swap only permutes which
    // slot holds which field at receive time; it does not change which fields the
    // key needs. With first_name absent, the swap key references an unproducible
    // field and must be excluded from the satisfiable count, identically to the
    // non-swap LN+FN+DOB key.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      ["last_name", "dob", "ssn"],
      allKeyTerms,
    );
    const unsatNames = new Set(unsatisfied.map((f) => f.name));
    expect(unsatNames.has("first_name")).toBe(true);
    // ssn+last_name+dob keys survive, so this is a partial (warn) case, proving the
    // swap key's exclusion is not just the whole set collapsing to zero.
    expect(satisfiableKeyCount).toBeGreaterThan(0);
    expect(satisfiableKeyCount).toBeLessThan(allKeyTerms.linkageKeys.length);
    const swapKey = allKeyTerms.linkageKeys.find((k) => k.swap !== undefined);
    expect(swapKey).toBeDefined();
    if (swapKey === undefined) return;
    // The detector reads e.field on the stored (unswapped) elements; the swap key
    // needs first_name, which is unsatisfiable, so it is correctly excluded.
    expect(swapKey.elements.some((e) => unsatNames.has(e.field))).toBe(true);
  });

  test("a key referencing an undeclared field is unsatisfiable even when no declared field is missing", () => {
    // The schema does not require a key element's `field` to name a declared
    // linkage field. A key referencing an undeclared field resolves to no values
    // at exchange time (buildStandardizedDataset only builds declared fields), so
    // it must be counted unsatisfiable -- otherwise an incoherent or hostile terms
    // set defeats the block and runs to a silent empty result. Build such terms by
    // dropping ssn from the declared fields while keeping the keys that use it.
    const base = getDefaultLinkageTerms(
      "Agency A",
      inferMetadata(FULL_COLUMNS),
    );
    const keysUsingSsn = base.linkageKeys.filter((k) =>
      k.elements.some((e) => e.field === "ssn"),
    ).length;
    expect(keysUsingSsn).toBeGreaterThan(0);
    const undeclaredTerms: LinkageTerms = {
      ...base,
      linkageFields: base.linkageFields.filter((f) => f.name !== "ssn"),
    };
    // FULL_COLUMNS has an ssn column, so no DECLARED field is unproducible...
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      undeclaredTerms,
    );
    expect(unsatisfied).toEqual([]);
    // ...yet the keys that reference the undeclared ssn are excluded.
    expect(satisfiableKeyCount).toBe(base.linkageKeys.length - keysUsingSsn);
    expect(satisfiableKeyCount).toBeLessThan(base.linkageKeys.length);
  });

  test("terms whose every key references an undeclared field report zero satisfiable keys (the block signal)", () => {
    // The strong form of the above: if all keys reference undeclared fields, the
    // count is 0 and the caller blocks, even though `unsatisfied` (declared but
    // unproducible) is empty.
    const base = getDefaultLinkageTerms(
      "Agency A",
      inferMetadata(FULL_COLUMNS),
    );
    const firstNameField = base.linkageFields.find(
      (f) => f.name === "first_name",
    );
    expect(firstNameField).toBeDefined();
    if (firstNameField === undefined) return;
    const phantomTerms: LinkageTerms = {
      ...base,
      linkageFields: [firstNameField],
      linkageKeys: [{ name: "needs ssn", elements: [{ field: "ssn" }] }],
    };
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      FULL_COLUMNS,
      phantomTerms,
    );
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(0);
  });
});

// --- assessLinkageSatisfiability: dead keys (self-defeating standardization) --

describe("assessLinkageSatisfiability dead keys", () => {
  // A single date_of_birth field bound to a present "dob" column, so the key is
  // always SHAPE-satisfiable; the element transform decides whether it is dead.
  const dobTerms = (
    transform?: LinkageKeyElement["transform"],
  ): LinkageTerms => ({
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
  });
  const columns = ["dob"];

  test("a parse_date element transform whose input omits a component is a dead key", () => {
    // input_format "MM/DD" (no year): core's parseDateFactory requires all of
    // YYYY/MM/DD, so it drops every record -- the key can never match.
    const { unsatisfied, satisfiableKeyCount, deadKeys } =
      assessLinkageSatisfiability(
        columns,
        dobTerms([
          { function: "parse_date", params: { inputFormat: "MM/DD" } },
        ]),
      );
    // The column is present, so the field is satisfiable and the key passes the
    // column-SHAPE verdict -- the silent gap this fills: the count alone reads
    // all-clear.
    expect(unsatisfied).toEqual([]);
    expect(satisfiableKeyCount).toBe(1);
    // ...yet the key is reported dead.
    expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
  });

  test("the real builder also produces no key string for that element (differential)", () => {
    // Pin the detector's "dead" verdict against an actual builder run, so a future
    // parse_date change that the predicate fails to mirror turns red here rather
    // than silently letting a silent-empty config through.
    const terms = dobTerms([
      { function: "parse_date", params: { inputFormat: "MM/DD" } },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/1990" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toBeNull();
  });

  test("a non-string parse_date input format is a dead key, without crashing the check", () => {
    // Wire params are z.unknown(), so a partner can supply a non-string input
    // format. None yields a value at runtime (every non-string tokenizes to an
    // all-dropping pattern), so each is dead -- and assessLinkageSatisfiability
    // must report it without ever tokenizing the non-string itself.
    for (const inputFormat of [5, true, ["MM"], { x: 1 }]) {
      const { deadKeys } = assessLinkageSatisfiability(
        columns,
        dobTerms([{ function: "parse_date", params: { inputFormat } }]),
      );
      expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
    }
  });

  test("the builder also drops every record for a non-string input format (differential)", () => {
    for (const inputFormat of [5, ["MM"], { x: 1 }, true]) {
      const terms = dobTerms([
        { function: "parse_date", params: { inputFormat } },
      ]);
      const dataset = buildStandardizedDataset(
        undefined,
        [{ dob: "01/15/1990" }],
        inferMetadata(columns),
        terms,
      );
      expect(
        buildKeyStrings(terms.linkageKeys[0], dataset, 0),
        JSON.stringify(inputFormat),
      ).toBeNull();
    }
  });

  test("a complete parse_date input format is not a dead key", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD/YYYY" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a bare parse_date (defaulted complete input) is not a dead key", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([{ function: "parse_date" }]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a two-digit-year parse_date element transform is not a dead key", () => {
    // The YY token supplies the year component, so the format tokenizes a full
    // date and the key is not self-defeating.
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD/YY" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a YY parse_date in a key ELEMENT transform resolves via the fixed constant (differential)", () => {
    const terms = dobTerms([
      {
        function: "parse_date",
        params: { inputFormat: "MM/DD/YY", outputFormat: "YYYYMMDD" },
      },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/90" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toEqual(
      new Set(["19900115"]),
    );
  });

  test("the builder produces a key string for a two-digit-year format (differential)", () => {
    // Pin the "not dead" verdict for MM/DD/YY against an actual builder run: a
    // two-digit-year DOB column yields a non-empty key on the default path.
    const terms = dobTerms([
      { function: "parse_date", params: { inputFormat: "MM/DD/YY" } },
    ]);
    const dataset = buildStandardizedDataset(
      undefined,
      [{ dob: "01/15/90" }],
      inferMetadata(columns),
      terms,
    );
    expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).not.toBeNull();
  });

  test("a later coalesce default rescues a dead parse_date to a constant (not dead)", () => {
    // The element yields the constant "X" for every row -- a producible, if
    // low-cardinality, key the linkage layer treats as benign, so it is not dead.
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD" } },
        { function: "coalesce", params: { default: "X" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("a coalesce with no string default does not rescue a dead parse_date", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "parse_date", params: { inputFormat: "MM/DD" } },
        { function: "coalesce" },
      ]),
    );
    expect(deadKeys.map((k) => k.name)).toEqual(["DOB"]);
  });

  test("a shape-unsatisfiable key is not double-reported as dead", () => {
    // The column is absent, so the key fails the SHAPE verdict (satisfiableKeyCount
    // 0); even with a dead element transform it is reported by the count, not
    // also listed in deadKeys, which is scoped to shape-satisfiable keys.
    const { satisfiableKeyCount, deadKeys } = assessLinkageSatisfiability(
      ["other_column"],
      dobTerms([{ function: "parse_date", params: { inputFormat: "MM/DD" } }]),
    );
    expect(satisfiableKeyCount).toBe(0);
    expect(deadKeys).toEqual([]);
  });

  test("the recommended default setup reports no dead keys", () => {
    // The default date_of_birth parse_date lives in the field standardization with
    // a complete input, and the default keys have no element transforms, so no
    // key is dead -- the no-signal-on-the-default-setup guarantee.
    const { deadKeys } = assessLinkageSatisfiability(FULL_COLUMNS, fullTerms);
    expect(deadKeys).toEqual([]);
  });

  test("a predicate-dead parse_date yields no key across a generated input-format corpus (differential)", () => {
    const permute = (a: string[]): string[][] =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) =>
            permute([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [
              x,
              ...p,
            ]),
          );
    const subsets: string[][] = [
      [],
      ["YYYY"],
      ["MM"],
      ["DD"],
      ["YYYY", "MM"],
      ["YYYY", "DD"],
      ["MM", "DD"],
      ["YYYY", "MM", "DD"],
    ];
    const formats = new Set<string>(["", "x", "---", "12"]);
    for (const subset of subsets)
      for (const ordering of permute(subset))
        for (const sep of ["", "-", "/", ".", " "])
          formats.add(ordering.join(sep));

    for (const inputFormat of formats) {
      const terms = dobTerms([
        { function: "parse_date", params: { inputFormat } },
      ]);
      const { deadKeys } = assessLinkageSatisfiability(columns, terms);
      // A format the detector does NOT call dead may legitimately produce a value
      // (data-dependent), which the detector ignores -- skip it.
      if (deadKeys.length === 0) continue;
      // A value shaped to the declared format, plus other shapes: a dead format
      // must yield no key for ANY of them.
      const shaped = inputFormat
        .replaceAll("YYYY", "2025")
        .replaceAll("MM", "01")
        .replaceAll("DD", "15");
      for (const value of [shaped, "2025", "01", "15", "20250115", "", "x"]) {
        const dataset = buildStandardizedDataset(
          undefined,
          [{ dob: value }],
          inferMetadata(columns),
          terms,
        );
        expect(buildKeyStrings(terms.linkageKeys[0], dataset, 0)).toBeNull();
      }
    }
  });

  // A `substring` whose declared bounds open no window is dead on the bounds
  // alone. The first six cases are schema-admitted: bounds an operator leaves
  // unset or clears mid-edit, and the two zeroes its integer refine cannot
  // express. The last three the schema rejects at parse but are kept because
  // this grading also runs over terms not built through that schema, the same
  // defense-in-depth `decideLinkageTermsVerdict` keeps for an undeclared field.
  const DEGENERATE_WINDOWS: ReadonlyArray<
    [string, Record<string, unknown> | undefined]
  > = [
    ["no params at all", undefined],
    ["empty params", {}],
    ["start unset", { length: 5 }],
    ["length unset", { start: 3 }],
    ["start of 0", { start: 0, length: 5 }],
    ["length of 0", { start: 3, length: 0 }],
    ["fractional start", { start: 1.5, length: 5 }],
    ["string start", { start: "3", length: 5 }],
    ["null length", { start: 3, length: null }],
  ];

  test("a substring whose bounds open no window is a dead key", () => {
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const terms = dobTerms([
        { function: "substring", ...(params !== undefined && { params }) },
      ]);
      const { unsatisfied, satisfiableKeyCount, deadKeys } =
        assessLinkageSatisfiability(columns, terms);
      // The column is present, so the field is satisfiable and the key passes
      // the column-SHAPE verdict -- the silent gap this fills.
      expect([label, unsatisfied]).toEqual([label, []]);
      expect([label, satisfiableKeyCount]).toEqual([label, 1]);
      expect([label, deadKeys.map((k) => k.name)]).toEqual([label, ["DOB"]]);
    }
  });

  test("the builder produces no key string for those bounds, whatever the value (differential)", () => {
    // Pin each "dead" verdict against actual builder runs over values of every
    // length a window under these bounds could open at, so a future change to
    // the slicing convention that the predicate fails to mirror turns red here
    // rather than silently minting terms that match nothing.
    const rows = Array.from({ length: 40 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const key: LinkageKey = {
        name: "DOB",
        elements: [
          {
            field: "dob",
            transform: [
              {
                function: "substring",
                ...(params !== undefined && { params }),
              },
            ],
          },
        ],
      };
      const dataset = new StandardizedDataset(
        [new StandardizedField("dob", "dob", [], rows)],
        [key],
      );
      for (let index = 0; index < rows.length; index++)
        expect([label, index, buildKeyStrings(key, dataset, index)]).toEqual([
          label,
          index,
          null,
        ]);
    }
  });

  test("a substring that reads a window somewhere is not a dead key", () => {
    // The other side of the claim, so the test above is not passing because
    // every substring is called dead: each of these opens a window at some
    // value length, including the negative lengths that count back from the
    // value's end and the window that overshoots every short value, so the drop
    // is the data's to decide and is not claimed.
    const rows = Array.from({ length: 120 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    for (const params of [
      { start: 3, length: 5 },
      { start: 1, length: 1 },
      { start: -2, length: 1 },
      { start: 1, length: -1 },
      { start: -2, length: -1 },
      { start: 3, length: -3 },
      { start: 99, length: 4 },
    ]) {
      const terms = dobTerms([{ function: "substring", params }]);
      const { deadKeys } = assessLinkageSatisfiability(columns, terms);
      expect([params, deadKeys]).toEqual([params, []]);
      // Not vacuous: some value length really does key under these bounds.
      const dataset = new StandardizedDataset(
        [new StandardizedField("dob", "dob", [], rows)],
        terms.linkageKeys,
      );
      const keyed = rows.some(
        (_row, index) =>
          buildKeyStrings(terms.linkageKeys[0], dataset, index) !== null,
      );
      expect([params, keyed]).toEqual([params, true]);
    }
  });

  test("a later coalesce default rescues a degenerate substring window (not dead)", () => {
    const { deadKeys } = assessLinkageSatisfiability(
      columns,
      dobTerms([
        { function: "substring" },
        { function: "coalesce", params: { default: "X" } },
      ]),
    );
    expect(deadKeys).toEqual([]);
  });

  test("the declared-window verdict matches the builder across a bounds grid (differential)", () => {
    // The verdict reads the slicing convention a second time
    // (substringWindowDropsEveryValue against substringWindow): every bound
    // pair in the grid is checked against value lengths up to 96, past any
    // window here can first open at, and a disagreement in either direction
    // is a failure. Over-claiming would hard-block a producible pipeline;
    // under-claiming would let one that matches nothing through.
    const BOUND = 16;
    const rows = Array.from({ length: 97 }, (_, length) => ({
      dob: "9".repeat(length),
    }));
    const dataset = new StandardizedDataset(
      [new StandardizedField("dob", "dob", [], rows)],
      [{ name: "DOB", elements: [{ field: "dob" }] }],
    );
    const divergent: string[] = [];
    let claimedDead = 0;
    let pairs = 0;
    for (let start = -BOUND; start <= BOUND; start++) {
      if (start === 0) continue;
      for (let length = -BOUND; length <= BOUND; length++) {
        pairs += 1;
        const params = { start, length };
        const key: LinkageKey = {
          name: "DOB",
          elements: [
            { field: "dob", transform: [{ function: "substring", params }] },
          ],
        };
        const measuredDead = rows.every(
          (_row, index) => buildKeyStrings(key, dataset, index) === null,
        );
        const claimed = substringWindowDropsEveryValue(params);
        if (claimed) claimedDead += 1;
        if (claimed !== measuredDead)
          divergent.push(
            `${JSON.stringify(params)}: claimed=${claimed} measured=${measuredDead}`,
          );
      }
    }
    expect(divergent.slice(0, 3)).toEqual([]);
    expect(divergent).toHaveLength(0);
    // Not vacuous: the grid reaches both verdicts.
    expect(pairs).toBe(2 * BOUND * (2 * BOUND + 1));
    expect(claimedDead).toBeGreaterThan(0);
    expect(claimedDead).toBeLessThan(pairs);
  });
});

// --- decideLinkageTermsVerdict: the grading a run is held to -----------------

describe("decideLinkageTermsVerdict", () => {
  // Two independent keys over two fields, so a case can leave one key short
  // while the other stays live -- the shape the collapsed rule turns on.
  const twoKeyTerms = (
    keyElements: LinkageKey["elements"][] = [
      [{ field: "dob" }],
      [{ field: "ssn" }],
    ],
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: keyElements.map((elements, i) => ({
      name: `KEY${i}`,
      elements,
    })),
  });
  const deadTransform = [
    { function: "parse_date" as const, params: { inputFormat: "MM/DD" } },
  ];

  test("every key satisfiable and live -> the run may proceed", () => {
    const verdict = decideLinkageTermsVerdict(["dob", "ssn"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(true);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "satisfiable",
      "satisfiable",
    ]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.deadKeys).toEqual([]);
    expect(verdict.unsatisfiedFields).toEqual([]);
  });

  test("one unsatisfiable key among satisfiable ones -> refused", () => {
    const verdict = decideLinkageTermsVerdict(["dob"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "satisfiable",
      "unsatisfiable",
    ]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual(["KEY1"]);
    expect(verdict.deadKeys).toEqual([]);
    expect(verdict.unsatisfiedFields.map((f) => f.name)).toEqual(["ssn"]);
  });

  test("one dead key among live ones -> refused", () => {
    // Both keys' columns are present, so the column check passes; KEY0's own
    // element cleaning drops every record regardless of the data.
    const verdict = decideLinkageTermsVerdict(
      ["dob", "ssn"],
      twoKeyTerms([
        [{ field: "dob", transform: deadTransform }],
        [{ field: "ssn" }],
      ]),
    );
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual(["dead", "satisfiable"]);
    expect(verdict.deadKeys.map((k) => k.name)).toEqual(["KEY0"]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.unsatisfiedFields).toEqual([]);
  });

  test("no satisfiable key -> refused", () => {
    const verdict = decideLinkageTermsVerdict(["other_column"], twoKeyTerms());
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "unsatisfiable",
      "unsatisfiable",
    ]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual([
      "KEY0",
      "KEY1",
    ]);
    expect(verdict.unsatisfiedFields.map((f) => f.name)).toEqual([
      "dob",
      "ssn",
    ]);
  });

  test("every satisfiable key dead -> refused", () => {
    const verdict = decideLinkageTermsVerdict(
      ["dob"],
      twoKeyTerms([
        [{ field: "dob", transform: deadTransform }],
        [{ field: "ssn" }],
      ]),
    );
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys.map((k) => k.fitness)).toEqual([
      "dead",
      "unsatisfiable",
    ]);
    expect(verdict.deadKeys.map((k) => k.name)).toEqual(["KEY0"]);
    expect(verdict.unsatisfiableKeys.map((k) => k.name)).toEqual(["KEY1"]);
  });

  test("terms declaring no linkage key at all -> refused", () => {
    // A key-count threshold passes this vacuously (0 satisfiable of 0 declared),
    // and linkageTermsFromRuleSet reaches it by narrowing the built-in set all
    // the way down when the columns support no key.
    const verdict = decideLinkageTermsVerdict(["dob", "ssn"], twoKeyTerms([]));
    expect(verdict.fullySatisfied).toBe(false);
    expect(verdict.keys).toEqual([]);
    expect(verdict.unsatisfiableKeys).toEqual([]);
    expect(verdict.deadKeys).toEqual([]);
  });

  test("linkageTermsFromRuleSet can derive the keyless terms the verdict refuses", () => {
    // The derived-defaults path, not a hand-built fixture: metadata holding no
    // linkage-roled column narrows the built-in rule set to no key.
    const derived = linkageTermsFromRuleSet(DEFAULT_LINKAGE_RULE_SET, "Party", [
      {
        name: "row_id",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      },
    ]);
    expect(derived.linkageKeys).toEqual([]);
    expect(decideLinkageTermsVerdict(["row_id"], derived).fullySatisfied).toBe(
      false,
    );
  });

  test("assessLinkageSatisfiability projects the same grading", () => {
    // The per-key readout and the run's verdict must not drift: the shape count
    // is exactly the keys the verdict does not grade unsatisfiable.
    const columns = ["dob"];
    const terms = twoKeyTerms([
      [{ field: "dob", transform: deadTransform }],
      [{ field: "ssn" }],
    ]);
    const verdict = decideLinkageTermsVerdict(columns, terms);
    const { unsatisfied, satisfiableKeyCount, deadKeys } =
      assessLinkageSatisfiability(columns, terms);
    expect(satisfiableKeyCount).toBe(
      verdict.keys.length - verdict.unsatisfiableKeys.length,
    );
    expect(deadKeys).toEqual(verdict.deadKeys);
    expect(unsatisfied).toEqual(verdict.unsatisfiedFields);
  });
});

// --- assertLinkageTermsSatisfiable: the run-boundary refusal -----------------

describe("assertLinkageTermsSatisfiable", () => {
  const oneKeyTerms = (name: string): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name, elements: [{ field: "ssn" }] }],
  });

  test("a fully satisfied input passes", () => {
    expect(() =>
      assertLinkageTermsSatisfiable(["ssn"], oneKeyTerms("SSN")),
    ).not.toThrow();
  });

  test("a shortfall raises the typed refusal and names it", () => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["other"], oneKeyTerms("SSN"));
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
    expect(raised).toBeInstanceOf(UsageError);
    // By design, not an OperatorConfigError: its message holds the agreed
    // terms' names, which are partner-authored on every accept path.
    expect(raised).not.toBeInstanceOf(OperatorConfigError);
    const rendered = sanitizeErrorForDisplay(raised);
    expect(rendered).toContain("out of band");
    expect(rendered).toContain("SSN");
    expect(rendered).toContain("ssn (ssn)");
  });

  test("keyless terms raise the refusal with no name enumeration to make", () => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["ssn"], {
        ...oneKeyTerms("SSN"),
        linkageKeys: [],
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    expect((raised as Error).cause).toBeUndefined();
    expect(sanitizeErrorForDisplay(raised)).toContain("declare no linkage key");
  });

  test("a partner-authored key name spends only its own display budget", () => {
    // The names ride cause links of their own, so a key name packed to the
    // display cap cannot truncate the summary or the remedy sentence.
    const shouting = "K".repeat(4000);
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["other"], oneKeyTerms(shouting));
    } catch (err) {
      raised = err;
    }
    const rendered = sanitizeErrorForDisplay(raised);
    expect(rendered).toContain("out of band");
    expect(rendered).toContain("unsatisfied linkage fields (1)");
  });

  // A key name is agreed-terms content, partner-authored on every accept
  // path, so it is redacted where the enumeration composes it: the display
  // boundary's dangling rule is fail-closed forward -- everything after a
  // BEGIN with no END -- so an unredacted marker in one name would take the
  // names enumerated behind it. Two unsatisfiable keys put the second name
  // behind the marker in the same link.
  const REDACTED_PRIVATE_KEY = "[redacted private key]";
  const twoUnsatisfiableKeyTerms = (
    firstName: string,
    secondName: string,
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [
      { name: firstName, elements: [{ field: "ssn" }] },
      { name: secondName, elements: [{ field: "ssn" }] },
    ],
  });

  const shortfallRender = (firstName: string): string => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(
        ["other"],
        twoUnsatisfiableKeyTerms(firstName, "SSN2"),
      );
    } catch (err) {
      raised = err;
    }
    return sanitizeErrorForDisplay(raised);
  };

  test("a key name holding a planted BEGIN marker leaves the other name standing", () => {
    const marker = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const rendered = shortfallRender(marker);
    expect(rendered).toContain("linkage keys this input cannot produce (2): ");
    expect(rendered).toContain(REDACTED_PRIVATE_KEY);
    expect(rendered).toContain("SSN2");
    expect(rendered).not.toContain(marker);
  });

  test("a key name that is a lone END marker deletes nothing", () => {
    // The rule reaches forward only, so an END marker with no BEGIN of its
    // own is ordinary text: it renders whole and takes no neighbour.
    const marker = "-----END OPENSSH PRIVATE KEY-----";
    const rendered = shortfallRender(marker);
    expect(rendered).toContain(
      `linkage keys this input cannot produce (2): ${marker}, SSN2`,
    );
    expect(rendered).not.toContain(REDACTED_PRIVATE_KEY);
  });

  test("a plain key name renders byte-for-byte as before", () => {
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["other"], oneKeyTerms("SSN"));
    } catch (err) {
      raised = err;
    }
    const rendered = sanitizeErrorForDisplay(raised);
    expect(rendered).toContain(
      "linkage keys this input cannot produce (1): SSN",
    );
  });
});

// --- summarizeLinkageShortfall: the wording both refusals state --------------

describe("summarizeLinkageShortfall", () => {
  const deadTransform = [
    { function: "parse_date", params: { inputFormat: "MM/DD" } },
  ];
  // One key per field, so a case picks each key's grade independently: withhold
  // the column to make it unsatisfiable, give it the dead transform to make it
  // dead.
  const twoKeyTerms = (
    ssnElement: LinkageKeyElement,
    dobElement: LinkageKeyElement,
  ): LinkageTerms => ({
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "dob", type: "date_of_birth" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [ssnElement] },
      { name: "DOB", elements: [dobElement] },
    ],
  });
  const summarize = (
    columns: string[],
    terms: LinkageTerms,
    standing: LinkageTermsStanding = "agreed",
  ): string =>
    summarizeLinkageShortfall(
      decideLinkageTermsVerdict(columns, terms),
      standing,
    );

  test("a lone declared key is named as the one it is", () => {
    expect(
      summarize(["dob"], {
        ...twoKeyTerms({ field: "ssn" }, { field: "dob" }),
        linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      }),
    ).toBe(
      "the one agreed linkage key cannot be produced from this input's columns",
    );
  });

  test("a shortfall over every declared key is counted as all of them", () => {
    expect(
      summarize(
        ["ssn", "dob"],
        twoKeyTerms(
          { field: "ssn", transform: deadTransform },
          { field: "dob", transform: deadTransform },
        ),
      ),
    ).toBe(
      "the cleaning declared for all 2 agreed linkage keys drops every record",
    );
  });

  test("both shortfall kinds are stated, each counted against the whole set", () => {
    expect(
      summarize(
        ["dob"],
        twoKeyTerms(
          { field: "ssn" },
          { field: "dob", transform: deadTransform },
        ),
      ),
    ).toBe(
      "1 of the 2 agreed linkage keys cannot be produced from this input's " +
        "columns, and the cleaning declared for 1 of the 2 agreed linkage keys " +
        "drops every record",
    );
  });

  // A seat holding terms no partner has yet counts the same keys without calling
  // them agreed: the shortfall is the operator's own draft falling short of its
  // own file, and there is nobody to have agreed to anything. Each count shape is
  // driven on both standings so an edit to one cannot quietly re-cross the other.
  test("a draft seat states the same counts and claims no agreement", () => {
    expect(
      summarize(
        ["dob"],
        {
          ...twoKeyTerms({ field: "ssn" }, { field: "dob" }),
          linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
        },
        "draft",
      ),
    ).toBe("the one linkage key cannot be produced from this input's columns");

    expect(
      summarize(
        ["ssn", "dob"],
        twoKeyTerms(
          { field: "ssn", transform: deadTransform },
          { field: "dob", transform: deadTransform },
        ),
        "draft",
      ),
    ).toBe("the cleaning declared for all 2 linkage keys drops every record");

    expect(
      summarize(
        ["dob"],
        twoKeyTerms(
          { field: "ssn" },
          { field: "dob", transform: deadTransform },
        ),
        "draft",
      ),
    ).toBe(
      "1 of the 2 linkage keys cannot be produced from this input's columns, " +
        "and the cleaning declared for 1 of the 2 linkage keys drops every " +
        "record",
    );
  });

  // The run boundary is an agreed seat: whoever authored the terms, the run it
  // guards is one a partner is held to as well, so it states the fragment with the
  // agreement named -- which `summarize` defaults to here.
  test("the run-boundary refusal states the agreed fragment verbatim", () => {
    const terms = twoKeyTerms(
      { field: "ssn" },
      { field: "dob", transform: deadTransform },
    );
    let raised: unknown;
    try {
      assertLinkageTermsSatisfiable(["dob"], terms);
    } catch (err) {
      raised = err;
    }
    expect(sanitizeErrorForDisplay(raised)).toContain(
      summarize(["dob"], terms),
    );
  });
});

// --- assessLinkageSatisfiability vs the real builder (differential) ----------

// assessLinkageSatisfiability is a second, hand-maintained copy of the
// column-to-field resolution buildStandardizedDataset performs; the guard is
// sound only while the two agree, pinned here against a real
// buildStandardizedDataset + buildKeyStrings run. Each case uses identity
// standardization and a non-empty value in every present column, isolating
// pure resolution from the shape-vs-values residual the detector ignores.
describe("assessLinkageSatisfiability matches buildStandardizedDataset", () => {
  // One ssn key and one lastName key, so a case can satisfy both, one, or neither.
  const diffTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Party",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "lastname", type: "last_name" },
    ],
    linkageKeys: [
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "NAME", elements: [{ field: "lastname" }] },
    ],
  };

  const cases: Array<{
    name: string;
    columns: string[];
    standardization?: Standardization;
    metadata?: ColumnMetadata[];
    expected: number;
  }> = [
    {
      name: "inferred, both keys satisfiable",
      columns: ["ssn", "last_name"],
      expected: 2,
    },
    {
      name: "inferred, only the name key satisfiable",
      columns: ["last_name"],
      expected: 1,
    },
    {
      name: "explicit metadata types a non-inferring column as ssn",
      columns: ["tax_id", "last_name"],
      metadata: [col("tax_id", "ssn"), col("last_name", "last_name")],
      expected: 2,
    },
    {
      name: "explicit metadata retypes the ssn column away",
      columns: ["ssn", "last_name"],
      metadata: [col("ssn", "other"), col("last_name", "last_name")],
      expected: 1,
    },
    {
      name: "absent same-typed metadata column ordered before a present one",
      columns: ["present_ssn", "last_name"],
      metadata: [
        col("absent_ssn", "ssn"),
        col("present_ssn", "ssn"),
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      // The remap target is roled `linkage`, so the explicit mapping binds it
      // even though its type is not `ssn` (the type fallback alone would not).
      name: "explicit standardization remaps to a present role:linkage column",
      columns: ["ssn_src", "last_name"],
      standardization: [{ output: "ssn", input: "ssn_src" }],
      metadata: [col("ssn_src", "other"), col("last_name", "last_name")],
      expected: 2,
    },
    {
      // Same remap, but the target is roled `payload`: matching requires
      // `role: linkage`, so the role wins over the explicit transform and ssn is
      // refused -- builder and checker agree (only the name key survives).
      name: "explicit standardization remaps to a present payload column (refused)",
      columns: ["ssn_src", "last_name"],
      standardization: [{ output: "ssn", input: "ssn_src" }],
      metadata: [
        { name: "ssn_src", type: "ssn", role: "payload", isPayload: true },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      name: "explicit standardization remaps to an absent column",
      columns: ["ssn", "last_name"],
      standardization: [{ output: "ssn", input: "tax_id" }],
      expected: 1,
    },
    {
      // A same-typed ssn column roled `payload` is NOT a default match field:
      // the type fallback binds only `role: linkage`, so ssn is unsatisfiable.
      name: "a payload-roled same-typed column is not a default match field",
      columns: ["ssn", "last_name"],
      metadata: [
        { name: "ssn", type: "ssn", role: "payload", isPayload: true },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
    {
      // Likewise a same-typed ssn column roled `identifier`.
      name: "an identifier-roled same-typed column is not a default match field",
      columns: ["ssn", "last_name"],
      metadata: [
        { name: "ssn", type: "ssn", role: "identifier", isPayload: false },
        col("last_name", "last_name"),
      ],
      expected: 1,
    },
  ];

  test.each(cases)(
    "$name",
    ({ columns, standardization, metadata, expected }) => {
      const row = Object.fromEntries(columns.map((c) => [c, "x"]));
      const builderMetadata = metadata ?? inferMetadata(columns);
      const dataset = buildStandardizedDataset(
        standardization,
        [row],
        builderMetadata,
        diffTerms,
      );
      const produced = diffTerms.linkageKeys.filter(
        (k) => buildKeyStrings(k, dataset, 0) !== null,
      ).length;
      const { satisfiableKeyCount } = assessLinkageSatisfiability(
        columns,
        diffTerms,
        standardization,
        metadata,
      );
      // The detector must agree with the real builder (the differential), and both
      // must equal the hand-checked count.
      expect(produced).toBe(expected);
      expect(satisfiableKeyCount).toBe(expected);
    },
  );
});
