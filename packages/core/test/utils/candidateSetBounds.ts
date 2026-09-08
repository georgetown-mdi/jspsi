import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../../src/fanOutFunctions";
import type { LinkageCardinality, SessionBounds } from "../../src/psi/link";

/**
 * One linkage key's column of realized values, one cell per row: a bare
 * string, the candidate SET a fan-out realizes, or `undefined` for a row with
 * no value for the key. The vocabulary the fan-out fixtures of both
 * strategies are written in, so a case can be run through either.
 */
export type Column = Array<string | Set<string> | undefined>;

/** The mirror label the partner of a party resolving `cardinality` holds. */
export function mirrorCardinality(
  cardinality: LinkageCardinality,
): LinkageCardinality {
  return cardinality === "many-to-one"
    ? "one-to-many"
    : cardinality === "one-to-many"
      ? "many-to-one"
      : cardinality;
}

/**
 * The per-key widths the AGREED terms declare for a fixture: the fan-out
 * factor for every key where either party realizes a candidate set, and one
 * otherwise. The width rides the agreed terms, so both parties hold the same
 * vector whichever of them fans out.
 */
export function declaredKeyWidths(
  ...columns: Array<Array<Column>>
): Array<number> {
  const keyCount = columns[0].length;
  const fansOut = columns
    .flat()
    .some((column) => column.some((cell) => cell instanceof Set));
  return new Array<number>(keyCount).fill(
    fansOut ? FAN_OUT_CANDIDATES_PER_ELEMENT : 1,
  );
}

/** The session bounds a cascade party holds for a fixture. */
export function candidateSetBounds(
  partnerRecordCount: number,
  keyWidths: ReadonlyArray<number>,
): SessionBounds {
  return { partnerRecordCount, keyWidths };
}
