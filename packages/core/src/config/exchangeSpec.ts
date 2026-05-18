import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { LinkageTermsSchema } from "./linkageTerms.js";
import { ConnectionConfigSchema } from "./connection.js";
import { StandardizationSchema } from "./standardization.js";
import { MetadataSchema } from "./metadata.js";

// ─── Exchange spec ───────────────────────────────────────────────────────────

/**
 * A complete PSI-Link exchange specification. Consumed by both the web
 * application and the CLI application. The web application provides an
 * interactive editor; the CLI accepts it as a configuration file.
 *
 * Any string value that begins with `@` is read from the file at the given
 * path rather than used literally. Apply `readAtSignFile` (or equivalent) to
 * credential fields before parsing.
 */
export const ExchangeSpecSchema = z.object({
  connection: ConnectionConfigSchema,
  linkageTerms: LinkageTermsSchema,
  metadata: MetadataSchema.optional(),
  standardization: StandardizationSchema.optional(),
});

export type ExchangeSpec = z.infer<typeof ExchangeSpecSchema>;

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw value as an {@link ExchangeSpec}.
 * Snake_case keys are converted to camelCase before validation, so JSON/YAML
 * from disk can be passed directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseExchangeSpec(raw: unknown): ExchangeSpec {
  return ExchangeSpecSchema.parse(camelizeKeys(raw));
}

/** Non-throwing version of {@link parseExchangeSpec}. */
export function safeParseExchangeSpec(raw: unknown) {
  return ExchangeSpecSchema.safeParse(camelizeKeys(raw));
}
