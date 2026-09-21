import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { psiChunkRanges } from "../../src/psi/psiChunks";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import {
  chunkIdentityValues,
  expectChunkedCountMatchesSingleCall,
  expectChunkedRoundMatchesSingleCall,
} from "../utils/psiChunkIdentity";

// The same byte-identity claim as test/psi/psiEngineChunkIdentity.test.ts, over
// a set the SHIPPED sizing policy splits rather than a chunk size the test set:
// the unit run proves the merges, this proves the sizes the engine picks at
// scale are ones they hold for. Minutes of masking per backend, which is why it
// is the opt-in tier; PSI_CHUNK_STRESS_N raises N for a heavier run.
const N = Number(process.env.PSI_CHUNK_STRESS_N ?? 24_576);

const { serverValues, clientValues } = chunkIdentityValues(N);

const wasm = await PSI();
// undefined when no prebuild ships for this platform (that leg skips); a broken
// addon throws through and fails rather than skipping silently.
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

// The counts the policy reports between chunks at this N, so a run that
// silently took one chunk (and proved nothing) fails instead of passing.
const expectedCounts = psiChunkRanges(N)
  .slice(0, -1)
  .map((range) => range.end);

test(`the policy splits ${N} elements into more than one chunk`, () => {
  expect(expectedCounts.length).toBeGreaterThan(0);
});

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend at the shipped chunk sizes", (_name, library) => {
  test("a chunked round reproduces the single call byte for byte", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const processed = await expectChunkedRoundMatchesSingleCall({
      library,
      serverValues,
      clientValues,
    });
    expect(processed).toStrictEqual({
      createServerSetup: expectedCounts,
      createClientRequest: expectedCounts,
      processClientRequest: expectedCounts,
      computeAssociationTable: expectedCounts,
    });
  });

  test("a chunked count-only round reports the single call's cardinality", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    expect(
      await expectChunkedCountMatchesSingleCall({
        library,
        serverValues,
        clientValues,
      }),
    ).toStrictEqual(expectedCounts);
  });
});
