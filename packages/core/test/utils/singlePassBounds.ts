import type { SinglePassSessionBounds } from "../../src/psi/link";

/**
 * The session bounds a FAN-OUT-FREE single-pass exchange holds: every key has
 * width one, which is what `declaredKeyWidth` returns for a key with no
 * expanding step, given neither party's own cleaning fans out. Written out at
 * the call site rather than defaulted inside `link.ts`, since the declared
 * widths and record counts drive the layout and every derived bound, and a
 * silent default would hide a divergence between them.
 */
export function fanOutFreeBounds(
  keyCount: number,
  partnerRecordCount: number,
): SinglePassSessionBounds {
  return {
    partnerRecordCount,
    keyWidths: new Array<number>(keyCount).fill(1),
    localFanOutFactor: 1,
  };
}
