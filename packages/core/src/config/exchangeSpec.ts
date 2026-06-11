import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { LinkageTermsSchema } from "./linkageTerms.js";
import { ConnectionConfigSchema } from "./connection.js";
import { StandardizationSchema } from "./standardization.js";
import { MetadataSchema } from "./metadata.js";
import { SigningConfigSchema } from "./signing.js";

// --- Exchange spec -----------------------------------------------------------

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
  // Optional signing block (receipt signing mode, this party's signing identity
  // file path, the pinned partner fingerprint, and the receipt output
  // location). Absent in exchanges that do not sign receipts; see signing.ts and
  // EXCHANGE_SPEC.md.
  signing: SigningConfigSchema.optional(),
  // Optional self-facing retention/disposition pointer for the self-attested
  // exchange record: a free-text operator note describing where this party files
  // its copy of the result and under what retention schedule it is held or
  // disposed of. Per-party and local -- it is written into THIS party's record
  // only, never swapped with the partner, cross-validated, or folded into the
  // agreed-terms hash (unlike linkageTerms). Metadata only: it must carry no
  // protected, linkage-field, or payload value. Non-empty when present (an absent
  // pointer is the omitted key, not an empty string). See EXCHANGE_SPEC.md and
  // EXCHANGE_RECORD.md.
  retentionDisposition: z.string().min(1).optional(),
});

export type ExchangeSpec = z.infer<typeof ExchangeSpecSchema>;

// --- Parse -------------------------------------------------------------------

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
