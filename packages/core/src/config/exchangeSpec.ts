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
 * A complete PSI-Link exchange specification. Consumed by both the web
 * application and the CLI application. The web application provides an
 * interactive editor; the CLI accepts it as a configuration file.
 *
 * Any string value that begins with `@` is read from the file at the given
 * path rather than used literally. Apply `readAtSignFile` (or equivalent) to
 * credential fields before parsing.
 *
 * `strictObject`: four of the top-level keys below -- `outboundPayloadConsent`,
 * `disclosedPayloadColumns`, `expectedPayloadColumns`,
 * `expectedPartnerDeduplicate` -- are enforcement records whose ABSENCE is a
 * valid state (reconcile lazily, no consent on record), so a misspelled key that
 * `strip` discards silently disables the control it names rather than failing
 * anything. That is the same reason `AuthenticationSchema` is strict, and it
 * applies to a machine-managed key the more sharply: an operator editing a
 * config around one has no display that would show the control had gone missing.
 * The nested blocks still strip -- see EXCHANGE_FILE.md ("Versioning and
 * compatibility policy") for what that means for a file minted by a newer web
 * app.
 */
export const ExchangeSpecSchema = z.strictObject({
  connection: ConnectionConfigSchema,
  linkageTerms: LinkageTermsSchema,
  metadata: MetadataSchema.optional(),
  standardization: StandardizationSchema.optional(),
  // Optional top-level authentication block: the partner shared-secret trust
  // mechanism, channel-agnostic across sftp/filedrop/webrtc. A sibling of
  // `signing` -- the two partner-trust mechanisms are deliberately kept separate
  // (opposed lifetimes and trust models); see SECURITY_DESIGN.md. It mixes
  // runtime-injected secret state (sharedSecret, expires, from .psilink.key,
  // never written to YAML and warn-and-stripped if set there) with
  // operator-settable policy fields. See connection.ts (Authentication) and
  // EXCHANGE_REFERENCE.md.
  authentication: AuthenticationSchema.optional(),
  // Optional signing block (receipt signing mode, this party's signing identity
  // file path, the pinned partner fingerprint, and the receipt output
  // location). Absent in exchanges that do not sign receipts; see signing.ts and
  // EXCHANGE_REFERENCE.md.
  signing: SigningConfigSchema.optional(),
  // Optional self-facing retention/disposition pointer for the self-attested
  // exchange record: a free-text operator note describing where this party files
  // its copy of the result and under what retention schedule it is held or
  // disposed of. Per-party and local -- it is written into THIS party's record
  // only, never swapped with the partner, cross-validated, or folded into the
  // agreed-terms hash (unlike linkageTerms). Metadata only: it must carry no
  // protected, linkage-field, or payload value. Non-empty when present (an absent
  // pointer is the omitted key, not an empty string). Length-capped to match the
  // record schema's retentionDisposition bound (MAX_TEXT_LENGTH): the record is
  // built from this value, so an over-long note would otherwise pass config
  // validation only to fail the record build and drop the audit record. See
  // EXCHANGE_REFERENCE.md and EXCHANGE_RECORD.md.
  retentionDisposition: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  // Optional local lock-in: the payload columns (in the PARTNER's namespace) this
  // party will enforce it receives at runtime (reconcileReceivedPayload). Per-party
  // and local like retentionDisposition -- NOT negotiated, swapped, cross-validated,
  // or folded into the agreed-terms hash, and deliberately distinct from
  // linkageTerms.payload.receive (which is the negotiated data dictionary and the
  // validateCompatibility send/receive mirror; reusing it would abort against an
  // inviter that advertised no payload.send). Two kinds of writer set it: a party
  // that learns the set UP FRONT -- an OFFLINE or ONLINE acceptance writes the
  // invitation's disclosedPayloadColumns here so a later `psilink exchange` enforces
  // what the operator consented to at accept time -- and a party that learns it only by
  // OBSERVING a first exchange -- the online inviter and a zero-setup `--save`
  // party crystallize the received set they observed (see
  // observedReceivedColumnsForSave in the CLI). An empty array is a strict "receive
  // nothing" (a non-empty payload then aborts); an absent field reconciles lazily.
  // An observe-on-save writer records only a NON-EMPTY observation for that reason:
  // an observed-empty set is an ambiguous zero-match run, left absent (lazy).
  // Bounded like a payload list; names are partner-controlled.
  expectedPayloadColumns: boundedArray(
    z.string().min(1).max(MAX_NAME_LENGTH),
    MAX_PAYLOAD_ENTRIES,
    `expectedPayloadColumns must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  // Optional local SEND-side commitment: the payload columns (in THIS party's OWN
  // namespace) it promised to disclose to its partner when the exchange was
  // established -- exactly the set carried on the invitation's
  // disclosedPayloadColumns and locked in by the partner as its
  // expectedPayloadColumns. The send-side mirror of expectedPayloadColumns above
  // (the partner-namespace RECEIVE lock-in): both are per-party and local -- NOT
  // negotiated, swapped, cross-validated, or folded into the agreed-terms hash, and
  // deliberately distinct from linkageTerms.payload.send (the negotiated dictionary).
  // Persisted by EVERY `psilink invite` mint path that publishes a disclosed set:
  // the online invite/bootstrap and offline infer-from-input paths write it into a
  // fresh config, and the offline invite-from-config / re-invite path refreshes it in
  // place (persistDisclosedPayloadColumns) so it can never lag the token the partner
  // locks in. A later recurring `psilink exchange` verifies its current metadata still
  // discloses exactly this set before any credential, terms, or data are sent
  // (assertDisclosureMatchesCommitment); a drift would otherwise silently under- or
  // over-deliver and make the partner -- which locked this set in -- abort
  // mid-exchange (reconcileReceivedPayload), a failure attributed to the partner.
  // The acceptor does not set this: it carries its commitment as payload.send
  // (checked by assertPayloadSendDisclosed) instead. An empty array is a strict
  // "disclose nothing" (a later metadata that discloses any column then fails); an
  // absent field reconciles lazily (no prior commitment on record, so no check).
  // Bounded like a payload list; the names are this party's own column names.
  disclosedPayloadColumns: boundedArray(
    z.string().min(1).max(MAX_NAME_LENGTH),
    MAX_PAYLOAD_ENTRIES,
    `disclosedPayloadColumns must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  // Optional local record of this party's consent to its OWN outbound payload set,
  // the third per-party local field beside the two above and never exchanged. It is
  // written by an ACCEPTANCE, whose outbound set no party authors: the invitation
  // authors the inviter's send and the mirror leaves the acceptor's own send absent,
  // so the set comes from this party's input columns and would otherwise be inferred
  // rather than chosen. Absent means no consent record (an inviter, a zero-setup run,
  // a hand-authored config), which changes nothing; `pending` and `confirmed` are
  // enforced by assertOutboundPayloadConsented before any credential, terms, or data
  // are sent. Distinct from disclosedPayloadColumns above, which records a promise
  // made TO THE PARTNER (which locked it in) rather than a choice made BY this
  // party, and which an acceptance does not set. See config/outboundPayloadConsent.ts.
  outboundPayloadConsent: OutboundPayloadConsentSchema.optional(),
  // Optional local TERMS-side lock-in, the deduplicate counterpart of
  // expectedPayloadColumns above: the `deduplicate` the accepted INVITATION
  // declared for the INVITING party's own side, which a later `psilink exchange`
  // holds the partner's presented value to at the terms exchange
  // (assertPresentedDeduplicateMatchesInvitation), refusing a contradiction before
  // any key or payload moves. Per-party and local like the three payload records
  // above -- NOT negotiated, swapped, cross-validated, or folded into the
  // agreed-terms hash -- and deliberately distinct from linkageTerms.deduplicate,
  // which is THIS party's own side (deriveAcceptedLinkageTerms sets an
  // acceptance's own value to false and retains nothing of the inviter's).
  // Written by every acceptance that persists a config: the offline accept's
  // fresh write, the online accept's bootstrap write and its reuse-path refresh,
  // and the browser's managed-record and server-job composers. ABSENT means no
  // invitation binding -- an exchange authored from two parties' own
  // configuration files, where the differing pair that makes one of them the
  // "many" side is legitimate and runs unaffected.
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
