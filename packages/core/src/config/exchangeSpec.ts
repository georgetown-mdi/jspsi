import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { LinkageTermsSchema } from "./linkageTerms.js";
import type { LinkageTerms } from "./linkageTerms.js";
import { ConnectionConfigSchema } from "./connection.js";
import type { ConnectionConfig } from "./connection.js";
import { StandardizationSchema } from "./standardization.js";
import type { Standardization } from "./standardization.js";
import { MetadataSchema } from "./metadata.js";
import type { Metadata } from "./metadata.js";

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
export interface ExchangeSpec {
  /**
   * Free-text string identifying this party (e.g. name, organization, contact
   * info). Required when `linkageTerms` is absent so that default terms can be
   * generated; included verbatim in the non-repudiation receipt otherwise.
   */
  identity?: string;
  /**
   * Linkage terms governing the exchange. When absent, defaults are generated
   * at runtime from the input data columns. `identity` is then required.
   */
  linkageTerms?: LinkageTerms;
  connection: ConnectionConfig;
  /** Optional field-level descriptions of the input dataset. */
  metadata?: Metadata;
  /** Optional data transformations applied before linkage key generation. */
  standardization?: Standardization;
}

export const ExchangeSpecSchema: z.ZodType<ExchangeSpec> = z
  .object({
    identity: z.string().min(1).optional(),
    linkageTerms: LinkageTermsSchema.optional(),
    connection: ConnectionConfigSchema,
    metadata: MetadataSchema.optional(),
    standardization: StandardizationSchema.optional(),
  })
  .refine((s) => s.linkageTerms !== undefined || s.identity !== undefined, {
    message: "identity is required when linkageTerms is not specified",
    path: ["identity"],
  });

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
