import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";

// Signing configuration for exchange receipts. Lives as an optional `signing`
// block on the ExchangeSpec (psilink.yaml); see EXCHANGE_SPEC.md. It carries
// only non-secret references: the path to this party's signing identity file
// (the private key lives there, NOT here), the receipt signing mode, the pinned
// partner certificate fingerprint (a public value exchanged out-of-band), and
// where signed receipts are written. The signing private key is deliberately
// kept out of the config and out of the rotating PAKE key file; see
// docs/SECURITY_DESIGN.md.

/**
 * Canonical form of a certificate fingerprint: an unpadded base64url SHA-256
 * digest, which is exactly 43 characters (32 bytes). This is the stable string a
 * party shares with its partner out-of-band and the partner pins here. Sharing
 * the precise length lets a truncated or mistyped paste fail with a clear error
 * rather than silently never matching.
 */
export const FINGERPRINT_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * Receipt signing mode. Mirrors the two modes described in
 * docs/PROTOCOL.md#non-repudiation, plus an explicit `none`:
 * - `none` -- no receipt is signed (only the unsigned self-attested record).
 * - `session-derived` -- a MAC under the shared PAKE session key; tamper-evident
 *   but not non-repudiation and not third-party verifiable.
 * - `certificate` -- a signature under this party's long-lived signing identity,
 *   the only mode that yields third-party-verifiable non-repudiation. This is the
 *   mode this provisioning work supports.
 *
 * The enum is the extensibility seam for the trust model: a future
 * authority-backed (X.509/CA) mode layers on as an additional value without
 * changing the ones above.
 */
export type SigningMode = "none" | "session-derived" | "certificate";

const SigningModeSchema: z.ZodType<SigningMode> = z.enum([
  "none",
  "session-derived",
  "certificate",
]);

/**
 * The `signing` block of an {@link ExchangeSpec}. All paths are local to the
 * party that holds the config; `partnerFingerprint` is the only field that
 * crosses the trust boundary, and it is a public value (a hash of a public
 * certificate) obtained from the partner over a trusted out-of-band channel.
 */
export interface SigningConfig {
  /** Receipt signing mode for this exchange. */
  mode: SigningMode;
  /**
   * Path to this party's signing identity file (private key + self-signed
   * certificate). Owner-read-only; created and read by the CLI. Optional here:
   * the CLI falls back to a documented default path when it is omitted.
   */
  identityFile?: string;
  /**
   * The partner's pinned certificate fingerprint (unpadded base64url SHA-256),
   * exchanged out-of-band at setup. A presented partner certificate is trusted
   * only if its fingerprint matches this value; an absent value means no partner
   * certificate can be trusted yet (verification is rejected with a clear
   * error). Long-lived: it stays valid until the partner deliberately
   * regenerates its identity.
   */
  partnerFingerprint?: string;
  /**
   * Where signed receipts / evidence are written. Optional; the CLI falls back
   * to a documented default when omitted.
   */
  receiptOutput?: string;
}

const SigningConfigSchema: z.ZodType<SigningConfig> = z.object({
  mode: SigningModeSchema,
  identityFile: z.string().min(1).optional(),
  partnerFingerprint: z
    .string()
    .regex(
      FINGERPRINT_REGEX,
      "partner_fingerprint must be an unpadded base64url SHA-256 digest (43 " +
        "characters); obtain it from your partner via 'psilink fingerprint' and " +
        "a trusted out-of-band channel",
    )
    .optional(),
  receiptOutput: z.string().min(1).optional(),
});

/**
 * Schema for the optional `signing` block, exported so {@link ExchangeSpecSchema}
 * can embed it. Field-shape validation only: cross-field requirements (e.g. that
 * certificate mode needs a pinned partner fingerprint before a partner
 * certificate can be verified) are enforced at the verification call site so
 * generating an identity and printing its fingerprint do not require the
 * partner's fingerprint to exist yet.
 */
export { SigningConfigSchema };

/**
 * Parse and validate a raw value as a {@link SigningConfig}. Snake_case keys are
 * converted to camelCase before validation, so JSON/YAML from disk can be passed
 * directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseSigningConfig(raw: unknown): SigningConfig {
  return SigningConfigSchema.parse(camelizeKeys(raw));
}

/** Non-throwing version of {@link parseSigningConfig}. */
export function safeParseSigningConfig(raw: unknown) {
  return SigningConfigSchema.safeParse(camelizeKeys(raw));
}
