import { describe, expect, test, vi } from "vitest";

import {
  NON_EMPTY_WORKER_ROW_THRESHOLD,
  computeNonEmptyRates,
  isSilentEmpty,
  shouldComputeOffThread,
} from "../../src/psi/nonEmptyAggregate.js";

import { NonEmptyRateController } from "../../src/psi/nonEmptyAggregateController.js";

import type {
  AggregateRequest,
  AggregateResponse,
  AggregateWorker,
} from "../../src/psi/nonEmptyAggregateController.js";

import type { Standardization } from "@psilink/core";

describe("computeNonEmptyRates: the silent-empty defense", () => {
  test("a transform that collapses every row to null surfaces a 0% non-empty rate", () => {
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
    const [rate] = computeNonEmptyRates(rows, standardization);
    expect(rate.total).toBe(2);
    expect(rate.nonEmpty).toBe(0);
    expect(rate.rate).toBe(0);
    expect(rate.unavailable).toBe(false);
    // The alarm fires.
    expect(isSilentEmpty(rate)).toBe(true);
  });

  test("a field whose rows clean to a real value reports a non-zero rate, no alarm", () => {
    // "" cleans to "" -- an empty key, NOT a usable value -- so it is not counted;
    // the two real names are. This pins that an empty string is treated as empty.
    const rows = [{ n: "Mary" }, { n: "Jane" }, { n: "" }];
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "n",
        steps: [{ function: "to_upper_case" }],
      },
    ];
    const [rate] = computeNonEmptyRates(rows, standardization);
    expect(rate.total).toBe(3);
    expect(rate.nonEmpty).toBe(2);
    expect(isSilentEmpty(rate)).toBe(false);
  });

  test("a field that collapses every row to an empty STRING also fires the alarm", () => {
    // trim over an all-blank column yields "" for every row: a degenerate key shared
    // by every row, no linkage signal -- the alarm must fire exactly as for null.
    const rows = [{ c: "  " }, { c: " " }, { c: "\t" }];
    const standardization: Standardization = [
      {
        output: "first_name",
        input: "c",
        steps: [{ function: "trim_whitespace" }],
      },
    ];
    const [rate] = computeNonEmptyRates(rows, standardization);
    expect(rate.nonEmpty).toBe(0);
    expect(isSilentEmpty(rate)).toBe(true);
  });

  test("the sweep observes empties, so coalesce rescuing dropped rows raises the rate", () => {
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
    expect(computeNonEmptyRates(rows, dropOnly)[0].nonEmpty).toBe(1);

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
    expect(computeNonEmptyRates(rows, withCoalesce)[0].nonEmpty).toBe(3);
  });

  test("an empty CSV is not flagged as a collapse, and a missing column counts as empty", () => {
    expect(isSilentEmpty(computeNonEmptyRates([], stdFor("c"))[0])).toBe(false);
    // A row lacking the input column carries no value; it still counts toward total.
    const rows = [{ other: "x" }, { other: "y" }];
    const [rate] = computeNonEmptyRates(rows, stdFor("c"));
    expect(rate.total).toBe(2);
    expect(rate.nonEmpty).toBe(0);
    expect(isSilentEmpty(rate)).toBe(true);
  });

  test("a step left mid-edit makes the field unavailable, not a false 0% alarm", () => {
    // pad_left with no length throws at compile; the field is reported unavailable
    // (its rate unknown) rather than crashing the whole sweep or reading as a collapse.
    const rows = [{ n: "42" }];
    const standardization: Standardization = [
      { output: "first_name", input: "n", steps: [{ function: "pad_left" }] },
    ];
    const [rate] = computeNonEmptyRates(rows, standardization);
    expect(rate.unavailable).toBe(true);
    expect(isSilentEmpty(rate)).toBe(false);
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
  private rows: ReadonlyArray<Record<string, string>> = [];

  postMessage(message: AggregateRequest): void {
    this.received.push(message);
    if (message.kind === "rows") {
      this.rows = message.rawRows;
      return;
    }
    const response: AggregateResponse = {
      token: message.token,
      rates: computeNonEmptyRates(this.rows, message.standardization),
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
    expect(shouldComputeOffThread(NON_EMPTY_WORKER_ROW_THRESHOLD)).toBe(false);
    expect(shouldComputeOffThread(NON_EMPTY_WORKER_ROW_THRESHOLD + 1)).toBe(
      true,
    );
  });

  test("computes inline below the threshold without spawning a worker", async () => {
    const spawn = vi.fn(() => new FakeAggregateWorker());
    const rows = rowsOf(3);
    const controller = new NonEmptyRateController(rows, spawn);
    expect(controller.offThread).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    await expect(controller.compute(UPPER)).resolves.toEqual(
      computeNonEmptyRates(rows, UPPER),
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
    // The result came back through the worker, and equals the off-thread compute.
    expect(fake.received).toContainEqual({
      kind: "compute",
      token: 0,
      standardization: UPPER,
    });
    expect(rates).toEqual(computeNonEmptyRates(rows, UPPER));

    // A second recompute reuses the same worker and re-seeds nothing.
    await controller.compute(UPPER);
    const rowSeedings = fake.received.filter((m) => m.kind === "rows");
    expect(rowSeedings).toHaveLength(1);
    expect(fake.received.filter((m) => m.kind === "compute")).toHaveLength(2);

    controller.dispose();
    expect(fake.terminated).toBe(true);
  });
});
