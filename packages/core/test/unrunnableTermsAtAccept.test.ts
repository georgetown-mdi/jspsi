import { expect, test } from "vitest";

import { deriveAcceptedLinkageTerms } from "../src/linkageTermsNegotiation";
import { transformRefusalIn } from "../src/linkageSatisfiability";
import { runPipeline } from "../src/standardization";
import { UsageError } from "../src/errors";
import type {
  LinkageTerms,
  TransformStep,
} from "../src/config/linkageTermsSchema";

// A step whose factory refuses its declared params is not a shape any schema
// reads: the params are absent or out of range rather than mistyped, so the
// document parses and the throw waits for key realization. The accept boundary
// is where this party still holds the decision, so it compiles the invitation's
// element transforms there (assertTransformsCompile) and refuses one that
// cannot be built. The run keeps its own compile: terms built or mutated
// without an accept reach it.

const ACCEPTOR = "Accepting Org";

function termsWith(transform: TransformStep[]): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Inviting Org",
    date: "2026-01-15",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn", transform }] }],
  };
}

/** Each way a factory refuses what a document may legitimately declare. */
const uncompilableSteps: ReadonlyArray<{
  name: string;
  transform: TransformStep[];
}> = [
  { name: "pad_left with no length", transform: [{ function: "pad_left" }] },
  {
    name: "pad_left with a multi-character fill",
    transform: [{ function: "pad_left", params: { length: 5, char: "00" } }],
  },
  {
    name: "phonetic naming an unimplemented algorithm",
    transform: [{ function: "phonetic", params: { algorithm: "metaphone" } }],
  },
  {
    name: "a function this build does not have",
    transform: [{ function: "not_a_real_function" }],
  },
];

test.each(uncompilableSteps)("the accept refuses $name", ({ transform }) => {
  const terms = termsWith(transform);
  // The gap the refusal closes: the same steps compile only at key
  // realization (applyElementTransform), which is inside the run.
  expect(() => runPipeline("123456789", transform)).toThrow();
  expect(() => deriveAcceptedLinkageTerms(terms, ACCEPTOR)).toThrow(UsageError);
});

test("the accept refusal states what to change without echoing the document", () => {
  const terms = termsWith([{ function: "pad_left" }]);
  const raised: unknown = (() => {
    try {
      deriveAcceptedLinkageTerms(terms, ACCEPTOR);
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  })();

  expect(raised).toBeInstanceOf(UsageError);
  // The machine-readable tag an authoring front end reads, naming a function
  // label this build recognizes rather than a byte the inviter wrote.
  expect(transformRefusalIn(raised)).toEqual({
    reason: "uncompilable-step",
    stepLabel: '"pad_left"',
  });
  for (const authored of ["Inviting Org", "SSN", "ssn"])
    expect((raised as UsageError).message).not.toContain(authored);
});

test("an invitation whose transforms compile still accepts", () => {
  const terms = termsWith([
    { function: "pad_left", params: { length: 9, char: "0" } },
  ]);
  const derived = deriveAcceptedLinkageTerms(terms, ACCEPTOR);

  expect(derived.identity).toBe(ACCEPTOR);
  expect(derived.linkageKeys).toEqual(terms.linkageKeys);
  expect(
    runPipeline("12345", derived.linkageKeys[0].elements[0].transform ?? []),
  ).toBe("000012345");
});
