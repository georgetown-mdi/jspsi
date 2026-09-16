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
 * It is Zod's own `max_length` check with the string comparison replaced, so
 * everything a caller can observe past the count is Zod's and needs no
 * restating here: the `too_big` issue, its default text and key order, the
 * `message` a bound names for itself, the non-aborting continuation into the
 * checks chained after it, the `maximum` a JSON Schema conversion reads, and
 * which values the check runs on at all -- a value that is not a string
 * (which reaches here only after the type check already refused it) is left
 * to Zod's own comparison. `test/utils/maxCodeUnits.test.ts` pins that
 * against the rendered text of the `.max()` this stands in for.
 *
 * A named `message` goes in the check's own `error` rather than in the issue
 * pushed below: Zod resolves a check's message after it sets the issue's
 * `path`, so an issue that already holds a message serializes its keys in a
 * different order from the one `.max(n, { message })` produces.
 */
export const maxCodeUnits = (
  maximum: number,
  message?: string,
): z.core.$ZodCheck<string> => {
  const check = new z.core.$ZodCheckMaxLength({
    check: "max_length",
    maximum,
    ...(message === undefined ? {} : { error: () => message }),
  });
  const zodLengthComparison = check._zod.check;
  check._zod.check = (payload) => {
    if (typeof payload.value !== "string") {
      zodLengthComparison(payload);
      return;
    }
    if (payload.value.length <= maximum) return;
    payload.issues.push({
      origin: "string",
      code: "too_big",
      maximum,
      inclusive: true,
      input: payload.value,
      continue: true,
      inst: check,
    });
  };
  return check;
};
