import { z } from "zod";

/**
 * A string length ceiling counted in UTF-16 CODE UNITS (`value.length`).
 *
 * This is the unit every length bound on partner-supplied content counts --
 * on the wire, in an exchange record, in a configuration, and at the
 * send-side gate -- and it is stated here rather than at each bound. The
 * hand-written predicates that share these ceilings are authoritative and
 * count the same way: the wire frame's column-name check
 * (`payloadExchange.ts`) and `overlongDisclosedColumnPositions`
 * (`config/metadata.ts`).
 *
 * Zod's own `.max()` counts code POINTS from 4.5.0 on, so a bare `.max(n)`
 * accepts a name of n astral characters -- 2n code units -- that those
 * predicates refuse. This check stands in for `.max()` on every string bound
 * so the two sides cannot disagree about which values are refused;
 * `test/config/lengthBoundUnitParity.test.ts` holds them to it.
 *
 * A `.min(1)` floor needs no counterpart: a string holds at least one code
 * unit exactly when it holds at least one code point.
 *
 * The refusal is Zod's own `too_big` issue, so it reports what `.max()`
 * reported and, like `.max()`, does not abort the checks chained after it.
 * `message` replaces the default text where a bound named its own.
 */
export const maxCodeUnits =
  (maximum: number, message?: string): z.core.CheckFn<string> =>
  (ctx) => {
    if (ctx.value.length <= maximum) return;
    ctx.issues.push({
      origin: "string",
      code: "too_big",
      maximum,
      inclusive: true,
      input: ctx.value,
      continue: true,
      ...(message === undefined ? {} : { message }),
    });
  };
