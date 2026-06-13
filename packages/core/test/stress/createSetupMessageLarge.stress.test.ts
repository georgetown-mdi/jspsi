import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

// Regression for the seclink fork's Server#createSetupMessage. It populated the
// caller's sorting permutation with `permutation.push(...Permutation)`; once the
// input set passed V8's spread-argument limit (~125k) that threw
// "RangeError: Maximum call stack size exceeded", crashing any starter whose
// deduplicated key set was that large (e.g. a health-plan member roster). The
// fork now pre-sizes and index-assigns instead. Run comfortably past the cliff;
// PSI_STRESS_N lets a heavier run (e.g. nightly) push it higher.
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
