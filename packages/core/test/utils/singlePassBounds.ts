import type { SinglePassSessionBounds } from "../../src/link";

/**
 * The session bounds a FAN-OUT-FREE single-pass exchange carries: every key
 * declares a width of one, which is what `declaredKeyWidth` returns for a key
 * whose elements declare no expanding step, and neither party's own cleaning fans
 * out. Written out at the seam rather than defaulted inside `link.ts`, because the
 * declared widths and record counts are what the layout and every derived bound
 * are chosen from and a silent default would hide a divergence between them.
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
