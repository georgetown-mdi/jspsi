import { z } from "zod";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import {
  LinkageTermsSchema,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
} from "./linkageTerms.js";
import { AuthenticationSchema, ConnectionConfigSchema } from "./connection.js";
import { StandardizationSchema } from "./standardization.js";
import { MetadataSchema } from "./metadata.js";
import { OutboundPayloadConsentSchema } from "./outboundPayloadConsent.js";
import { SigningConfigSchema } from "./signing.js";
import { boundedArray } from "../utils/boundedArray.js";

// --- Exchange spec -----------------------------------------------------------

/**
 * A complete psilink exchange specification. Consumed by both the web
 * application and the CLI application: the web app provides an interactive
 * editor, the CLI accepts it as a configuration file.
 *
 * Any string value beginning with `@` is read from the file at that path
 * rather than used literally; apply `readAtSignFile` (or equivalent) to
 * credential fields before parsing.
 *
 * `strictObject`: `outboundPayloadConsent`, `disclosedPayloadColumns`,
 * `expectedPayloadColumns`, and `expectedPartnerDeduplicate` are
 * enforcement records whose ABSENCE is a valid state, so a misspelled key
 * that `strip` discards would silently disable the control it names. The
 * nested blocks still strip -- see EXCHANGE_FILE.md ("Versioning and
 * compatibility policy").
 */
export const ExchangeSpecSchema = z.strictObject({
  connection: ConnectionConfigSchema,
  linkageTerms: LinkageTermsSchema,
  metadata: MetadataSchema.optional(),
  standardization: StandardizationSchema.optional(),
  // Optional top-level authentication block: the partner shared-secret
  // trust mechanism, channel-agnostic across sftp/filedrop/webrtc. A
  // sibling of `signing`, kept separate since the two have opposed
  // lifetimes and trust models (see SECURITY_DESIGN.md). Mixes
  // runtime-injected secret state (from .psilink.key, never written to
  // YAML) with operator-settable policy fields. See connection.ts and
  // EXCHANGE_REFERENCE.md.
  authentication: AuthenticationSchema.optional(),
  // Optional signing block (receipt signing mode, this party's signing identity
  // file path, the pinned partner fingerprint, and the receipt output
  // location). Absent in exchanges that do not sign receipts; see signing.ts and
  // EXCHANGE_REFERENCE.md.
  signing: SigningConfigSchema.optional(),
  // Optional self-facing retention/disposition note for the self-attested
  // exchange record: free text describing where this party files its copy
  // and under what retention schedule. Per-party and local -- written into
  // THIS party's record only, never swapped, cross-validated, or folded
  // into the agreed-terms hash. Metadata only: must carry no protected,
  // linkage-field, or payload value. Length-capped to the record schema's
  // bound (MAX_TEXT_LENGTH) so an over-long note fails here rather than at
  // record build. See EXCHANGE_REFERENCE.md and EXCHANGE_RECORD.md.
  retentionDisposition: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  // Optional local enforcement record: the payload columns (in the
  // PARTNER's namespace) this party will enforce it receives at runtime
  // (reconcileReceivedPayload). Per-party and local like
  // retentionDisposition -- not negotiated, swapped, cross-validated, or
  // folded into the agreed-terms hash, and distinct from
  // linkageTerms.payload.receive (the negotiated dictionary).
  // Two kinds of writer: a party that learns the set UP FRONT (an offline
  // or online acceptance writes the invitation's disclosedPayloadColumns
  // here), and one that learns it only by OBSERVING a first exchange (the
  // online inviter and a zero-setup `--save` party crystallize what they
  // observed). An empty array is a strict "receive nothing"; an absent
  // field reconciles lazily. An observe-on-save writer records only a
  // NON-EMPTY observation, since an observed-empty set is an ambiguous
  // zero-match run. Bounded like a payload list; names are
  // partner-controlled.
  expectedPayloadColumns: boundedArray(
    z.string().min(1).max(MAX_NAME_LENGTH),
    MAX_PAYLOAD_ENTRIES,
    `expectedPayloadColumns must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  // Optional local SEND-side commitment: the payload columns (in THIS
  // party's OWN namespace) it promised to disclose when the exchange was
  // established -- the send-side mirror of expectedPayloadColumns above.
  // Per-party and local, distinct from linkageTerms.payload.send (the
  // negotiated dictionary). Persisted by every `psilink invite` mint path
  // that publishes a disclosed set, so it never lags the token the
  // partner locks in. A later recurring `psilink exchange` verifies its
  // current metadata still discloses exactly this set before any
  // credential, terms, or data are sent
  // (assertDisclosureMatchesCommitment): drift would otherwise abort the
  // partner mid-exchange, attributing the failure to them. The acceptor
  // does not set this (it carries payload.send instead). An empty array
  // is a strict "disclose nothing"; an absent field reconciles lazily.
  // Bounded like a payload list; names are this party's own.
  disclosedPayloadColumns: boundedArray(
    z.string().min(1).max(MAX_NAME_LENGTH),
    MAX_PAYLOAD_ENTRIES,
    `disclosedPayloadColumns must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  // Optional local record of this party's consent to its OWN outbound
  // payload set, the third per-party local field beside the two above and
  // never exchanged. Written only by an acceptance, whose outbound set no
  // party authors (see config/outboundPayloadConsent.ts for the full
  // states). Distinct from disclosedPayloadColumns above, which records a
  // promise made TO THE PARTNER rather than a choice made BY this party.
  outboundPayloadConsent: OutboundPayloadConsentSchema.optional(),
  // Optional local TERMS-side enforcement record, the deduplicate
  // counterpart of expectedPayloadColumns above: the `deduplicate` the accepted
  // INVITATION declared for the INVITING party's own side, which a later
  // `psilink exchange` holds the partner's presented value to
  // (assertPresentedDeduplicateMatchesInvitation), refusing a
  // contradiction before any key or payload moves. Per-party and local,
  // distinct from linkageTerms.deduplicate (THIS party's own side).
  // Written by every acceptance that persists a config. ABSENT means no
  // invitation binding -- an exchange authored from two parties' own
  // config files, where a differing pair is legitimate and runs
  // unaffected.
  expectedPartnerDeduplicate: z.boolean().optional(),
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

/**
 * Non-throwing version of {@link parseExchangeSpec}. Honors the "safe" contract
 * for the {@link camelizeKeys} bounds too -- see {@link safeParseCamelized}.
 */
export function safeParseExchangeSpec(raw: unknown) {
  return safeParseCamelized(ExchangeSpecSchema, raw);
}
