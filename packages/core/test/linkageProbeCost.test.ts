// What the `parse_date` collapse probe costs the editor's grading pass, held to
// a count rather than to a clock: the compiles it asks of `compileSteps` over a
// document at the schema's per-element step maximum. A wall-clock assertion
// would measure the machine; this measures the walk.
//
// The file is its own suite because the count needs `compileSteps` mocked, which
// vitest applies to the whole module for the whole file.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/standardization", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/standardization")>();
  return { ...actual, compileSteps: vi.fn(actual.compileSteps) };
});

import { compileSteps } from "../src/standardization";
import {
  decideLinkageTermsVerdict,
  pipelineAlwaysDrops,
  pipelineCollapsesParsedDateToConstant,
} from "../src/linkageSatisfiability";
import { MAX_TRANSFORM_STEPS } from "../src/config/linkageTermsSchema";
import type {
  LinkageTerms,
  TransformStep,
} from "../src/config/linkageTermsSchema";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";

const compileStepsSpy = vi.mocked(compileSteps);

/** Every step handed to `compileSteps` since the last reset, however many calls
 * carried them. The walk compiles one step per call and the tail reading a whole
 * slice, so the steps rather than the calls are what the cost is counted in. */
const stepsCompiled = (): number =>
  compileStepsSpy.mock.calls.reduce(
    (total, [steps]) => total + steps.length,
    0,
  );

/**
 * The most expensive shape the probe admits: one `parse_date` laying out the
 * value, then alternating `substring` and `trim_whitespace` so EVERY substring
 * ends a maximal run and every run's measured span reaches back to the
 * `parse_date`. Measuring each run on its own re-runs the probes over a span
 * that grows with the index, which is quadratic in the element's step count; one
 * forward pass over the element is linear in it.
 */
function probeShapedSteps(count: number): TransformStep[] {
  const steps: TransformStep[] = [
    {
      function: "parse_date",
      params: { inputFormat: "YYYY-MM-DD", outputFormat: "ACME-YYYYMMDD" },
    },
  ];
  while (steps.length < count) {
    steps.push({ function: "substring", params: { start: 1, length: 4 } });
    if (steps.length < count) steps.push({ function: "trim_whitespace" });
  }
  return steps.slice(0, count);
}

/** A schema-shaped document of `elementCount` elements, each declaring
 * `stepsPerElement` of the shape above against the same date field. */
function termsOf(elementCount: number, stepsPerElement: number): LinkageTerms {
  const base = getDefaultLinkageTerms("probe cost");
  return {
    ...base,
    linkageKeys: [
      {
        name: "date_of_birth",
        elements: Array.from({ length: elementCount }, (_, index) => ({
          field: "date_of_birth",
          name: `element_${index}`,
          transform: probeShapedSteps(stepsPerElement),
        })),
      },
    ],
  };
}

describe("parse_date probe cost", () => {
  beforeEach(() => {
    compileStepsSpy.mockClear();
  });

  test("compiles each of an element's measured steps once, not once per run", () => {
    pipelineAlwaysDrops(probeShapedSteps(MAX_TRANSFORM_STEPS));
    // The `parse_date` itself is not measured, so the span is every later step.
    expect(stepsCompiled()).toBe(MAX_TRANSFORM_STEPS - 1);
  });

  test("the compiles stay linear in an element's step count", () => {
    const compiledFor = (count: number): number => {
      compileStepsSpy.mockClear();
      pipelineAlwaysDrops(probeShapedSteps(count));
      return stepsCompiled();
    };
    const small = compiledFor(MAX_TRANSFORM_STEPS / 4);
    const large = compiledFor(MAX_TRANSFORM_STEPS);
    expect(small).toBe(MAX_TRANSFORM_STEPS / 4 - 1);
    expect(large).toBe(MAX_TRANSFORM_STEPS - 1);
    // Four times the steps for four times the compiles. Measuring each run on
    // its own gives sixteen times them: 1024 and 16384 for these two lengths.
    expect(large / small).toBeLessThan(5);
  });

  test("grades a document at the per-element maximum within one compile per step", () => {
    const elementCount = 10;
    const terms = termsOf(elementCount, MAX_TRANSFORM_STEPS);
    const declaredSteps = elementCount * MAX_TRANSFORM_STEPS;
    decideLinkageTermsVerdict(["date_of_birth"], terms);
    expect(declaredSteps).toBe(2560);
    // 163840 compiled steps when each run is measured on its own.
    expect(stepsCompiled()).toBe(elementCount * (MAX_TRANSFORM_STEPS - 1));
    expect(stepsCompiled()).toBeLessThanOrEqual(declaredSteps);
  });

  test("the consent header's collapse marker reads one element in one walk", () => {
    const steps = probeShapedSteps(MAX_TRANSFORM_STEPS);
    expect(pipelineCollapsesParsedDateToConstant(steps)).toBe(true);
    // The first run collapses, so the marker is answered after that run's span
    // and its tail rather than after a walk per step.
    expect(stepsCompiled()).toBeLessThanOrEqual(MAX_TRANSFORM_STEPS);
  });
});
