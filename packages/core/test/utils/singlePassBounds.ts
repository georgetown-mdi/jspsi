import type { SinglePassSessionBounds } from "../../src/link";

/**
 * The authenticated session bounds a FAN-OUT-FREE single-pass exchange carries:
 * both parties advertise their plain key count, which is what
 * `declaredEffectiveKeyCount` returns for terms and a standardization declaring no
 * fan-out. Written out at the seam rather than defaulted inside `link.ts`, because
 * the two parties' advertisements are what the layout and every derived bound are
 * chosen from and a silent default would hide a divergence between them.
 */
export function fanOutFreeBounds(
  keyCount: number,
  partnerRecordCount: number,
): SinglePassSessionBounds {
  return {
    partnerRecordCount,
    localEffectiveKeyCount: keyCount,
    partnerEffectiveKeyCount: keyCount,
  };
}
