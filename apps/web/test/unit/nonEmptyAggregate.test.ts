import { afterEach, describe, expect, test, vi } from "vitest";

import { StandardizedField } from "@psilink/core";

import {
  NON_EMPTY_WORKER_CHAR_THRESHOLD,
  NON_EMPTY_WORKER_ROW_THRESHOLD,
  computeFieldCoverage,
  createFieldCoverageAccumulator,
  isSilentEmpty,
  shouldComputeOffThread,
} from "../../src/psi/nonEmptyAggregate.js";

import { NonEmptyRateController } from "../../src/psi/nonEmptyAggregateController.js";

import type {
  AggregateRequest,
  AggregateResponse,
  AggregateWorker,
} from "../../src/psi/nonEmptyAggregateController.js";

import type { CSVRow, Standardization } from "@psilink/core";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fan-out pipeline: a value containing the delimiter realizes several candidates. */
const SPLIT_ON_SPACE: Standardization = [
  {
    output: "first_name",
    input: "n",
    steps: [{ function: "split_on", params: { delimiter: " " } }],
  },
];

describe("computeFieldCoverage: the silent-empty defense", () => {
  test("a transform that collapses every row to null reports a 0% coverage alarm", () => {
    // parse_date with the wrong input format matches no row -> every value drops to
    // null. This is the cited hazard: SHAPE is satisfiable (a date column is bound)
    // but VALUE collapses, byte-indistinguishable from a real empty intersection.
    const rows = [{ dob: "1990-01-01" }, { dob: "1985-12-31" }];
    const standardization: Standardization = [
      {
        output: "date_of_birth",
        input: "dob",
        steps: [
          {
            function: "parse_date",
            params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
          },
        ],
      },
    ];
    const [coverage] = computeFieldCoverage(rows, standardization);
    expect(coverage.total).toBe(2);
    expect(coverage.produced).toBe(0);
    expect(coverage.rate).toBe(0);
    expect(coverage.unavailable).toBe(false);
    expect(isSilentEmpty(coverage)).toBe(true);
  });

  test("an empty string counts as a produced value, distinct from a dropped null", () => {
    // "" cleans to "" -- a participating key, NOT a drop -- so the blank row counts
    // toward produced, exactly as the per-row preview frames it. The field is not a
    // silent-empty collapse.
    const rows = [{ n: "Mary" }, { n: "Jane" }, { n: "" }];
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "n",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    const [coverage] = computeFieldCoverage(rows, standardization);
    expect(coverage.total).toBe(3);
    expect(coverage.produced).toBe(3);
    expect(isSilentEmpty(coverage)).toBe(false);
  });

  test("an all-empty-string field is fully produced, not a silent-empty collapse", () => {
    // trim over an all-blank column yields "" for every row: each "" is a produced
    // key (not a drop), so this is 100% produced, NOT zero coverage. A constant key
    // is not flagged -- core's linkage drops keys duplicated within a dataset before
    // the PSI round, so a constant key simply contributes no matches.
    const rows = [{ c: "  " }, { c: " " }, { c: "\t" }];
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "c",
        steps: [{ function: "trim_whitespace" }],
      },
    ];
    const [coverage] = computeFieldCoverage(rows, standardization);
    expect(coverage.produced).toBe(3);
    expect(coverage.rate).toBe(1);
    expect(isSilentEmpty(coverage)).toBe(false);
  });

  test("a fan-out (multi-value) row counts once, never more than the row it is", () => {
    // split_on emits a multi-value Set for a value that splits. Those values cross
    // into the key's candidate set the single-pass strategy matches on, so the row
    // is matchable and produced -- but as ONE row, keeping produced bounded by total
    // and the rate inside [0, 1]. A value with no delimiter stays a one-element Set
    // and is produced the same way, so a mixed column is fully covered.
    const mixed = computeFieldCoverage(
      [{ n: "mary jane" }, { n: "ann marie" }, { n: "mary" }],
      SPLIT_ON_SPACE,
    )[0];
    expect(mixed.total).toBe(3);
    expect(mixed.produced).toBe(3);
    expect(mixed.rate).toBe(1);
    expect(isSilentEmpty(mixed)).toBe(false);
  });

  test("an all-fan-out field is fully produced, not a 'cannot match' alarm", () => {
    // Every row splits, so a single-value reading would report zero coverage and fire
    // the red "no row produces a value ... it cannot match" alert on a field that does
    // match. A fan-out under a strategy that cannot realize the candidate set is
    // refused at authoring, at the mint, and at prepare (core's
    // assertFanOutImplemented), where the fault is named and fixable, so this readout
    // does not pre-warn for it.
    const allFanOut = computeFieldCoverage(
      [{ n: "mary jane" }, { n: "ann marie" }],
      SPLIT_ON_SPACE,
    )[0];
    expect(allFanOut.total).toBe(2);
    expect(allFanOut.produced).toBe(2);
    expect(allFanOut.rate).toBe(1);
    expect(isSilentEmpty(allFanOut)).toBe(false);
  });

  test("the sweep observes empties, so coalesce rescuing dropped rows raises coverage", () => {
    // The aggregate runs over the WHOLE row set (the preview's sample skips empties),
    // so a coalesce that substitutes a default for an otherwise-dropped value is
    // demonstrable here: null_if drops the "N/A" rows, coalesce then fills them.
    const rows = [{ n: "Mary" }, { n: "N/A" }, { n: "N/A" }];
    const dropOnly: Standardization = [
      {
        output: "first_name",
        input: "n",
        steps: [{ function: "null_if", params: { values: ["N/A"] } }],
      },
    ];
    expect(computeFieldCoverage(rows, dropOnly)[0].produced).toBe(1);

    const withCoalesce: Standardization = [
      {
        output: "first_name",
        input: "n",
        steps: [
          { function: "null_if", params: { values: ["N/A"] } },
          { function: "coalesce", params: { default: "UNKNOWN" } },
        ],
      },
    ];
    expect(computeFieldCoverage(rows, withCoalesce)[0].produced).toBe(3);
  });

  test("an empty CSV is not flagged, and a missing column collapses to silent-empty", () => {
    expect(isSilentEmpty(computeFieldCoverage([], stdFor("c"))[0])).toBe(false);
    // A row lacking the input column has no value; it still counts toward total.
    const rows = [{ other: "x" }, { other: "y" }];
    const [coverage] = computeFieldCoverage(rows, stdFor("c"));
    expect(coverage.total).toBe(2);
    expect(coverage.produced).toBe(0);
    expect(isSilentEmpty(coverage)).toBe(true);
  });

  test("a step left mid-edit makes the field unavailable, not a false alarm", () => {
    // pad_left with no length throws at compile; the field is reported unavailable
    // (coverage unknown) rather than crashing the sweep or reading as a collapse.
    const rows = [{ n: "42" }];
    const standardization: Standardization = [
      { output: "first_name", input: "n", steps: [{ function: "pad_left" }] },
    ];
    const [coverage] = computeFieldCoverage(rows, standardization);
    expect(coverage.unavailable).toBe(true);
    expect(isSilentEmpty(coverage)).toBe(false);
  });

  test("an over-length regex source is unavailable and never compiled", () => {
    // An in-dialect pattern longer than MAX_TRANSFORM_PATTERN_LENGTH (a 1001-char
    // literal) passes the dialect refine and would NOT throw, but compiling it pays
    // the super-linear RE2 compile cost the cap exists to bound. The sweep runs
    // inline on the main thread below the off-thread threshold, so the validity gate
    // reports the field unavailable WITHOUT compiling, never reading it as a collapse.
    const rows = [{ n: "mary" }];
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "n",
        steps: [
          { function: "filter_regex", params: { pattern: "a".repeat(1001) } },
        ],
      },
    ];
    const [coverage] = computeFieldCoverage(rows, standardization);
    expect(coverage.unavailable).toBe(true);
    expect(isSilentEmpty(coverage)).toBe(false);
  });
});

function stdFor(input: string): Standardization {
  return [
    { output: "first_name", input, steps: [{ function: "trim_whitespace" }] },
  ];
}

// A fake worker that mirrors the real one: it stores the seeded rows and, on a
// compute request, runs the SAME pure function the real worker runs and posts the
// result back asynchronously (a microtask, like a real worker message).
class FakeAggregateWorker implements AggregateWorker {
  onmessage: ((event: { data: AggregateResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly received: Array<AggregateRequest> = [];
  terminated = false;
  private rows: ReadonlyArray<CSVRow> = [];

  postMessage(message: AggregateRequest): void {
    this.received.push(message);
    if (message.kind === "rows") {
      this.rows = message.rawRows;
      return;
    }
    const response: AggregateResponse = {
      token: message.token,
      rates: computeFieldCoverage(this.rows, message.standardization),
    };
    queueMicrotask(() => this.onmessage?.({ data: response }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function rowsOf(count: number): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, i) => ({ n: `name${i}` }));
}

const UPPER: Standardization = [
  { output: "first_name", input: "n", steps: [{ function: "to_upper_case" }] },
];

describe("NonEmptyRateController: off-main-thread dispatch above the threshold", () => {
  test("the threshold predicate moves to the worker strictly above the row cap", () => {
    expect(shouldComputeOffThread(rowsOf(NON_EMPTY_WORKER_ROW_THRESHOLD))).toBe(
      false,
    );
    expect(
      shouldComputeOffThread(rowsOf(NON_EMPTY_WORKER_ROW_THRESHOLD + 1)),
    ).toBe(true);
  });

  test("a few very large cells move off-thread even below the row cap", () => {
    // The sweep cost is rows x fields x per-cell, so a tiny-row file with huge cells
    // would freeze the main thread inline; the size budget catches it. A normal small
    // file stays inline.
    const huge = "x".repeat(NON_EMPTY_WORKER_CHAR_THRESHOLD + 1);
    expect(shouldComputeOffThread([{ n: huge }])).toBe(true);
    expect(shouldComputeOffThread([{ n: "small" }, { n: "rows" }])).toBe(false);
  });

  test("computes inline below the threshold without spawning a worker", async () => {
    const spawn = vi.fn(() => new FakeAggregateWorker());
    const rows = rowsOf(3);
    const controller = new NonEmptyRateController(rows, spawn);
    expect(controller.offThread).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    await expect(controller.compute(UPPER)).resolves.toEqual(
      computeFieldCoverage(rows, UPPER),
    );
  });

  test("runs off the main thread above the threshold: spawns the worker, seeds the rows once, computes there", async () => {
    const fake = new FakeAggregateWorker();
    const spawn = vi.fn(() => fake);
    const rows = rowsOf(NON_EMPTY_WORKER_ROW_THRESHOLD + 1);
    const controller = new NonEmptyRateController(rows, spawn);

    // The off-thread path was taken, and the worker was seeded with the rows once at
    // construction (so a later edit posts only the standardization, never re-clones).
    expect(controller.offThread).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fake.received).toEqual([{ kind: "rows", rawRows: rows }]);

    const rates = await controller.compute(UPPER);
    expect(fake.received).toContainEqual({
      kind: "compute",
      token: 0,
      standardization: UPPER,
    });
    expect(rates).toEqual(computeFieldCoverage(rows, UPPER));

    // A second recompute reuses the same worker and re-seeds nothing.
    await controller.compute(UPPER);
    const rowSeedings = fake.received.filter((m) => m.kind === "rows");
    expect(rowSeedings).toHaveLength(1);
    expect(fake.received.filter((m) => m.kind === "compute")).toHaveLength(2);

    controller.dispose();
    expect(fake.terminated).toBe(true);
  });

  test("a worker error fails the in-flight compute and a later compute rejects, never hanging", async () => {
    const fake = new FakeAggregateWorker();
    const controller = new NonEmptyRateController(
      rowsOf(NON_EMPTY_WORKER_ROW_THRESHOLD + 1),
      () => fake,
    );

    // The compute in flight when the worker dies is rejected (not left hanging), so
    // the hook can settle to an unavailable state.
    const inFlight = controller.compute(UPPER);
    fake.onerror?.("boom");
    await expect(inFlight).rejects.toBe("boom");
    // The broken worker is torn down so nothing keeps posting to it.
    expect(fake.terminated).toBe(true);

    // A later compute on the now-failed controller rejects at once rather than posting
    // to the dead worker and hanging on a promise it can never answer (the regression
    // this guards: a one-off worker error otherwise wedged the check in `pending`).
    await expect(controller.compute(UPPER)).rejects.toThrow(
      "aggregate worker failed",
    );
  });

  test("a compute after dispose neither posts to the terminated worker nor settles", async () => {
    const fake = new FakeAggregateWorker();
    const controller = new NonEmptyRateController(
      rowsOf(NON_EMPTY_WORKER_ROW_THRESHOLD + 1),
      () => fake,
    );
    controller.dispose();

    const settled = vi.fn();
    void controller.compute(UPPER).then(settled, settled);
    // Flush microtasks: the disposed compute must not resolve, reject, or post a
    // compute message to the terminated worker.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(fake.received.filter((m) => m.kind === "compute")).toHaveLength(0);
  });
});

describe("createFieldCoverageAccumulator: streaming equals batch", () => {
  const standardization: Standardization = [
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "to_upper_case" }],
    },
    {
      output: "birth_date",
      input: "dob",
      steps: [
        { function: "parse_date", params: { inputFormat: "YYYY-MM-DD" } },
      ],
    },
    // A field left mid-edit stays `unavailable` on both drivers.
    {
      output: "pad",
      input: "last_name",
      steps: [{ function: "pad_left", params: {} }],
    },
  ];

  test("feeding rows one at a time equals computeFieldCoverage over the whole set", () => {
    const rows: Array<CSVRow> = [
      { last_name: "Public", dob: "1990-01-02" },
      { last_name: "", dob: "not-a-date" },
      { last_name: "Adams", dob: "2000-05-14" },
      { dob: "1972-03-08" },
    ];
    const accumulator = createFieldCoverageAccumulator(standardization);
    for (const row of rows) accumulator.add(row);
    expect(accumulator.result()).toEqual(
      computeFieldCoverage(rows, standardization),
    );
  });

  test("an empty stream reports zero totals, not a divide-by-zero", () => {
    const accumulator = createFieldCoverageAccumulator(standardization);
    expect(accumulator.result()).toEqual(
      computeFieldCoverage([], standardization),
    );
  });

  test("a field whose pipeline throws on a row degrades to unavailable, not a sweep abort", () => {
    const rows: Array<CSVRow> = [
      { last_name: "Public" },
      { last_name: "boom" },
      { last_name: "Adams" },
    ];
    const realEvaluateRow = StandardizedField.prototype.evaluateRow;
    // A compiled pipeline can still throw on a specific row's value (a step that
    // slips past the validity gate). That row must degrade the field to unavailable
    // and stop its evaluation, never abort the whole sweep -- server-side one bad row
    // would otherwise 400 the entire coverage request.
    vi.spyOn(StandardizedField.prototype, "evaluateRow").mockImplementation(
      function (this: StandardizedField, row: CSVRow): Array<string> {
        if (row.last_name === "boom")
          throw new Error("row-time pipeline throw");
        return realEvaluateRow.call(this, row);
      },
    );
    const accumulator = createFieldCoverageAccumulator([
      {
        output: "last_name",
        input: "last_name",
        steps: [{ function: "to_upper_case" }],
      },
    ]);
    expect(() => {
      for (const row of rows) accumulator.add(row);
    }).not.toThrow();
    const [coverage] = accumulator.result();
    expect(coverage.total).toBe(3);
    expect(coverage.produced).toBe(0);
    expect(coverage.unavailable).toBe(true);
    expect(isSilentEmpty(coverage)).toBe(false);
  });
});
