import type { PsiElementBounds } from "../../src/connection/frameSize";

/**
 * PSI element-count bounds that never reject, for the unit tests that exercise PSI
 * correctness rather than the decode-seam amplification guard. Those tests predate
 * the guard and drive the participant with trusted, in-process inputs, so an
 * inert bound keeps them focused. The guard itself is pinned directly (a crafted
 * over-declared frame is rejected in psiParticipant.test.ts) and end to end by the
 * exchange integration tests, which derive real bounds from authenticated counts.
 */
export const UNBOUNDED_PSI_ELEMENTS: PsiElementBounds = {
  setup: Number.POSITIVE_INFINITY,
  request: Number.POSITIVE_INFINITY,
  response: Number.POSITIVE_INFINITY,
};
