import { z } from "zod";

import {
  camelizeKeys,
  NestingDepthExceededError,
  NodeCountExceededError,
} from "../utils/camelizeKeys.js";

/**
 * Shared camelize-then-`safeParse` behind every `safeParseX` config helper.
 * `camelizeKeys` runs before Zod's `safeParse` and throws on a
 * pathologically deep or wide input ({@link NestingDepthExceededError},
 * {@link NodeCountExceededError}); this converts either into a synthesized
 * `{ success: false }` result carrying one `custom` {@link z.ZodError} issue
 * with the bound's fixed text at the root path, so every `safeParseX` caller
 * gets a non-throwing result. Any other throw propagates unchanged. The
 * throwing `parseX` siblings call `camelizeKeys` directly instead; their
 * partner-wire call sites (`protocolSetup.ts`) catch the bound error there.
 * Internal to `@psilink/core`: not re-exported, not a stable public API.
 *
 * @internal
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
      // ZodError's constructor is not generic (yields ZodError<unknown>);
      // cast to ZodError<T> to match the return type. Safe: a synthesized
      // failure carries no `data`, so the cast's phantom output type is
      // never read.
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
