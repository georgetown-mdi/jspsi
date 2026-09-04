import { z } from "zod";

import { boundedArray } from "../utils/boundedArray.js";
import { MAX_NAME_LENGTH, MAX_PAYLOAD_ENTRIES } from "./linkageTerms.js";

/**
 * This party's recorded consent to its OWN outbound payload set -- the
 * columns it discloses to the partner for matched records.
 *
 * An acceptor's outbound set is authored by nobody: the invitation mirror
 * (`deriveAcceptedLinkageTerms`) leaves the acceptor's own `send` absent, so
 * the set is instead resolved from that party's own input columns
 * (`inferMetadata`). This record turns that resolved set from inferred into
 * chosen, distinct from the deliberate absent-`send` exception at
 * `assertPayloadSendDisclosed`.
 *
 * Per-party and LOCAL, like `expectedPayloadColumns` and
 * `disclosedPayloadColumns`: never exchanged, cross-validated, or folded
 * into the agreed-terms hash. Three states:
 *
 * - ABSENT -- no consent record; every party that is not an acceptor (an
 *   inviter, a zero-setup run, a hand-authored config).
 * - `pending` -- the set could not yet be resolved (no input file named, or
 *   its columns could not satisfy the invitation's linkage keys).
 * - `confirmed` -- the exact column set this party confirmed. A later run
 *   whose resolved set differs is refused before any credential, terms, or
 *   data are sent (`assertOutboundPayloadConsented`).
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
