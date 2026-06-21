import { z } from "zod";

import {
  camelizeKeys,
  NestingDepthExceededError,
  NodeCountExceededError,
} from "../utils/camelizeKeys.js";

/**
 * Shared camelize-then-`safeParse` behind every `safeParseX` config helper,
 * made genuinely non-throwing for the {@link camelizeKeys} structural bounds.
 *
 * `camelizeKeys` runs BEFORE Zod's `safeParse`, and on a pathologically deep or
 * wide input it throws a bounded-rejection error ({@link NestingDepthExceededError}
 * for the depth bound, {@link NodeCountExceededError} for the node-count/width
 * budget) -- a throw that would otherwise escape the "safe" contract a
 * `safeParseX` name promises (a `{ success: false }` result, not an exception)
 * for every caller, not just the ones wrapped in try/catch today. This converts
 * either bound into a synthesized `safeParse` failure with the shape Zod itself
 * produces: a {@link z.ZodError} carrying one `custom` issue whose message is the
 * bound's fixed text (no attacker- or operator-supplied bytes) at the root path
 * (`[]`). A caller that reads `result.error.issues` -- e.g. the CLI's
 * `loadConfigLinkageSource` file-naming formatter -- then handles a tripped
 * camelize bound identically to any other invalid input.
 *
 * Only the `safe` helpers route through here. The throwing `parseX` siblings
 * (`parseLinkageTerms` and the rest) deliberately call `camelizeKeys` directly
 * and keep throwing the bound error: their partner-wire call sites
 * (`protocolSetup.ts`) catch it and surface the same sanitized rejection.
 *
 * Any throw that is not one of the two camelize bounds is a genuine fault and
 * propagates unchanged.
 */
export function safeParseCamelized<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  widthBoundedKeys?: ReadonlyMap<string, number>,
): z.ZodSafeParseResult<T> {
  let camelized: unknown;
  try {
    camelized = camelizeKeys(raw, widthBoundedKeys);
  } catch (err) {
    if (
      err instanceof NestingDepthExceededError ||
      err instanceof NodeCountExceededError
    )
      // The ZodError runtime constructor is not generic (it yields
      // ZodError<unknown>); cast to ZodError<T> to match the failure result
      // shape. Safe because a synthesized failure carries no `data`, so the
      // phantom output type the cast asserts is never read.
      return {
        success: false,
        error: new z.ZodError([
          { code: "custom", path: [], message: err.message },
        ]) as z.ZodError<T>,
      };
    throw err;
  }
  return schema.safeParse(camelized);
}
