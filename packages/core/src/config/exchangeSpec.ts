import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { LinkageTermsSchema } from "./linkageTerms.js";
import type { LinkageTerms } from "./linkageTerms.js";
import { ConnectionConfigSchema } from "./connection.js";
import type { ConnectionConfig } from "./connection.js";

// ─── Metadata (stub) ─────────────────────────────────────────────────────────

// TODO: Implement per EXCHANGE_SPEC.md §"Input metadata".
export type Metadata = unknown;

// ─── Cleaning (stub) ─────────────────────────────────────────────────────────

// TODO: Implement per EXCHANGE_SPEC.md §"Data cleaning".
// The spec marks this section as a sketch; do not implement until finalized.
export type Cleaning = unknown;

// ─── Exchange spec ────────────────────────────────────────────────────────────

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
  linkageTerms: LinkageTerms;
  connection: ConnectionConfig;
  /** Optional field-level descriptions of the input dataset. */
  metadata?: Metadata;
  /** Optional data transformations applied before linkage key generation. */
  cleaning?: Cleaning;
}

export const ExchangeSpecSchema: z.ZodType<ExchangeSpec> = z.object({
  linkageTerms: LinkageTermsSchema,
  connection: ConnectionConfigSchema,
  metadata: z.unknown().optional(), // TODO: replace with typed schema
  cleaning: z.unknown().optional(), // TODO: replace with typed schema
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
