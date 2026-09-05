import type { PsiElementBounds } from "../../src/connection/frameSize";

/**
 * PSI element-count bounds that never reject, for unit tests exercising PSI
 * correctness rather than the decode-boundary amplification guard: those
 * tests drive the participant with trusted, in-process inputs, so an inert
 * bound keeps them focused. The guard itself is pinned directly in
 * psiParticipant.test.ts and end to end by the exchange integration tests,
 * which derive real bounds from authenticated counts.
 */
export const UNBOUNDED_PSI_ELEMENTS: PsiElementBounds = {
  setup: Number.POSITIVE_INFINITY,
  request: Number.POSITIVE_INFINITY,
  response: Number.POSITIVE_INFINITY,
};
