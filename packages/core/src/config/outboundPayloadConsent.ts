import { z } from "zod";

import { boundedArray } from "../utils/boundedArray.js";
import { MAX_NAME_LENGTH, MAX_PAYLOAD_ENTRIES } from "./linkageTerms.js";

/**
 * This party's recorded consent to its OWN outbound payload set -- the columns it
 * discloses to the partner for matched records.
 *
 * It exists because an accepting party's outbound set is authored by nobody. An
 * invitation authors the inviter's `payload.send` and, in the common shape, no
 * `payload.receive`, so the mirror an acceptance applies
 * (`deriveAcceptedLinkageTerms`) leaves the acceptor's own `send` ABSENT and the
 * set is instead resolved from that party's own input columns -- where every
 * unrecognized column becomes `role: payload, isPayload: true` (`inferMetadata`).
 * This record is what turns that resolved set from something inferred into
 * something chosen: it distinguishes "unauthored because nobody chose" (the field
 * is absent) from "authored by this party's confirmation" (`confirmed`), which is
 * the distinction the disclosure guards could not otherwise draw -- an absent
 * `payload.send` is a deliberate exception there (see `assertPayloadSendDisclosed`),
 * so holding the dictionary itself to equality would reject every guided and
 * default exchange.
 *
 * Per-party and LOCAL, like `expectedPayloadColumns` and
 * `disclosedPayloadColumns`: never exchanged, cross-validated, or folded into the
 * agreed-terms hash. The three states are distinct and none collapses into
 * another:
 *
 * - ABSENT (the field omitted) -- no consent record, so nothing is checked and
 *   transmission stays governed by metadata alone. This is every party that is not
 *   an acceptor: an inviter (whose own set it authored at mint and pinned as
 *   `disclosedPayloadColumns`), a zero-setup run, a hand-authored config.
 * - `pending` -- an acceptance that could not resolve the set (no input file was
 *   named, or its columns could not satisfy the invitation's linkage keys), so the
 *   party has consented to the invitation but not yet to its own disclosure. The
 *   set is resolved, shown, and confirmed at the first run that can (see
 *   `assertOutboundPayloadConsented`).
 * - `confirmed` -- the exact column set this party confirmed. A later run whose
 *   resolved set differs, in EITHER direction, is refused before any credential,
 *   terms, or data are sent rather than silently transmitting a different
 *   disclosure.
 */
export type OutboundPayloadConsent =
  | {
      /** The set was not resolvable when this party consented; nothing is confirmed yet. */
      status: "pending";
    }
  | {
      /** The set below was shown to this party and confirmed by it. */
      status: "confirmed";
      /**
       * The confirmed column names, in this party's OWN namespace -- exactly the
       * set `disclosedColumnNames` produced from the metadata resolved when it was
       * confirmed. An empty array is a real confirmation that nothing is
       * disclosed, not an absent record.
       */
      columns: string[];
    };

/**
 * Schema for {@link OutboundPayloadConsent}. `columns` carries the same
 * per-name length and entry-count bounds as every other payload column list, so a
 * hand-edited config cannot make the field unloadable in a way the writers could
 * not have produced; the discriminated union is what keeps a `confirmed` record
 * without columns, or a `pending` record carrying them, unrepresentable.
 */
export const OutboundPayloadConsentSchema: z.ZodType<OutboundPayloadConsent> =
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("confirmed"),
      columns: boundedArray(
        z.string().min(1).max(MAX_NAME_LENGTH),
        MAX_PAYLOAD_ENTRIES,
        `outbound payload consent must not exceed ${MAX_PAYLOAD_ENTRIES} columns`,
      ),
    }),
  ]);
