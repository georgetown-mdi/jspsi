import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

// Regression for the seclink fork's Server#createSetupMessage, which filled the
// caller's permutation via `permutation.push(...Permutation)`; an input set
// past V8's spread-argument limit (~125k) threw "RangeError: Maximum call stack
// size exceeded", crashing any starter with a deduplicated key set that large
// (e.g. a health-plan member roster). It now pre-sizes and index-assigns
// instead; PSI_STRESS_N raises N for a heavier run past this cliff.
const N = Number(process.env.PSI_STRESS_N ?? 200_000);

const psi = await PSI();

test(`createSetupMessage fills a ${N}-element sorting permutation without overflow`, () => {
  const set = Array.from({ length: N }, (_, i) => `id-${i}`);
  const sortingPermutation: number[] = [];

  const server = psi.server!.createWithNewKey(true);
  try {
    const setup = server.createSetupMessage(
      0.0,
      -1,
      set,
      psi.dataStructure.Raw,
      sortingPermutation,
    );

    // The crash was inside the permutation copy, so a permutation fully
    // populated to length N is the direct evidence it ran to completion.
    expect(sortingPermutation).toHaveLength(N);
    expect(setup.serializeBinary().length).toBeGreaterThan(0);
  } finally {
    server.delete();
  }
});
