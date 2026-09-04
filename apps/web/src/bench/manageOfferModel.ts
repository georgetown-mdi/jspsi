/**
 * The pure decision half of the "manage this exchange" offer the console makes at
 * invite creation (the inviter) and at accept (the acceptor). It composes the
 * fields a managed-exchange deposit needs -- the credential-free webrtc locator,
 * this party's exchange-file document, the deposited secret, this party's `side`,
 * and the optional max-age policy -- from what each completion surface already
 * holds, and it derives the operator-facing copy (the label cap and the max-age
 * cadence line). No React, no IndexedDB: the deposit itself (through
 * {@link createManagedExchange}) and the offer's UI state live in the components,
 * so the composition and the decline discipline are unit-testable in Node.
 *
 * Deposit shape and composition rules are normative in
 * docs/spec/MANAGED_EXCHANGE_RECORD.md: the record persists this party's whole
 * exchange-file document verbatim (no `authentication` block), composed from a
 * credential-free {@link WebRTCExchangeLocator} through the shared schema (see
 * {@link composeManagedExchangeFile}). The deposited secret is the invitation's
 * secret -- `sharedSecret` on the inviter's minted invitation, `token.sharedSecret`
 * on the acceptor's decoded one; the one-shot run that follows discards its own
 * derived rotation, so both parties' records stay coherent at the deposited value
 * until a later managed re-run rotates it. Declining leaves no record: the offer
 * is skipped and the one-shot flow's discard stands, so there is by design no
 * "compose then throw away" path here -- a caller that declines never composes.
 */

import {
  MAX_TOKEN_MAX_AGE_DAYS,
  deriveOutboundPayloadConsent,
} from "@psilink/core";

import {
  MAX_LABEL_LENGTH,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { rotationWriteBack } from "@psi/managedRunRotate";

import type {
  ExchangeSpec,
  Metadata,
  Standardization,
  WebRTCEndpoint,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type {
  ManagedExchangeSide,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";

/**
 * Build the credential-free {@link WebRTCExchangeLocator} the managed record's
 * connection block is composed from, out of a webrtc {@link WebRTCEndpoint}. The
 * acceptor's endpoint is the invitation's own endpoint; the inviter's is the one
 * {@link webrtcEndpointFromLocation} built for the token from this app's location.
 * Both are already the invitation's `WebRTCEndpointSchema` shape (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block"); this only drops
 * an absent optional the composer's strict parse would otherwise reject as
 * `undefined`.
 */
export function webrtcLocatorFromEndpoint(
  endpoint: WebRTCEndpoint,
): WebRTCExchangeLocator {
  return {
    channel: "webrtc",
    host: endpoint.host,
    ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
    ...(endpoint.path !== undefined ? { path: endpoint.path } : {}),
  };
}

/** The maximum operator label length, re-exported at the offer boundary so the
 * component enforces the same cap the record schema does (see
 * {@link MAX_LABEL_LENGTH}). */
export { MAX_LABEL_LENGTH };

/** The maximum max-token-age policy in days, re-exported at the offer boundary
 * so the component bounds its input at the same cap the record schema enforces
 * at write (core's {@link MAX_TOKEN_MAX_AGE_DAYS}). */
export { MAX_TOKEN_MAX_AGE_DAYS };

/** This party's own exchange-file substance at the completion surface, the parts
 * of the persisted document that are not the connection: the linkage terms this
 * party runs on (its own perspective), the optional per-party blocks, and the
 * payload-column commitments. The connection is supplied separately as a webrtc
 * locator, so this shape is transport-agnostic and identical for both sides. */
export interface ManagedExchangeDocumentParts {
  /**
   * This party's side of the partnership, and the deposit's ONE statement of it:
   * {@link buildManagedDeposit} composes the document from these parts and records
   * this same value as the record's `side`, so a deposit cannot store one side
   * while holding the other side's document. Required, not optional: an omitted
   * side would default to no outbound-payload consent record, a silent pass at
   * every later run (see {@link composeManagedDocument}).
   */
  side: ManagedExchangeSide;
  /** This party's linkage terms -- the inviter's minted terms, or the acceptor's
   * derived perspective (identity replaced, output/payload mirrored). */
  linkageTerms: ExchangeSpec["linkageTerms"];
  /** This party's edited column metadata, when authored. */
  metadata?: Metadata;
  /** This party's per-party standardization, when authored. */
  standardization?: Standardization;
  /**
   * This party's SEND-side disclosure commitment -- the inviter supplies the
   * token's own `disclosedPayloadColumns` (one source: the set the partner
   * consented to, never a re-derivation that could drift from it). Empty means a
   * strict "sends nothing" commitment; absent means no commitment on record (the
   * acceptor's send commitment rides its mirrored `payload.send` instead -- see
   * docs/spec/FILE_SYNC.md, "Which mint paths persist disclosedPayloadColumns").
   */
  disclosedPayloadColumns?: Array<string>;
  /**
   * This party's RECEIVE-side enforcement -- the acceptor supplies the
   * invitation token's `disclosedPayloadColumns` (the partner's committed send
   * set, in the partner's namespace), so a managed re-run fails CLOSED if the
   * partner transmits a different set than was consented to at accept, exactly
   * as the CLI accept persists it (docs/spec/FILE_SYNC.md, "Runtime lock-in").
   * Empty means a strict "receive nothing" enforcement; absent means lazy (no set
   * on the token). The inviter omits it: its received set is unknowable at mint,
   * crystallized only by observing the first exchange.
   */
  expectedPayloadColumns?: Array<string>;
  /**
   * This party's TERMS-side enforcement -- the acceptor supplies the invitation
   * token's `linkageTerms.deduplicate` (the value the invitation declared for the
   * INVITER's own side, and the one the consent screen stated), so a managed
   * re-run refuses an inviter presenting anything else at the terms exchange,
   * exactly as the CLI accept persists it. The inviter omits it: it accepted no
   * declaration, and its partner's side is the acceptor's own mirrored `false`.
   */
  expectedPartnerDeduplicate?: boolean;
}

/**
 * Compose this party's persisted exchange-file document from its own document
 * parts and the credential-free webrtc locator. The payload-column commitments
 * (`disclosedPayloadColumns`, `expectedPayloadColumns`, and
 * `expectedPartnerDeduplicate`) are caller-supplied and carried verbatim, never
 * re-derived, so the persisted commitment cannot disagree with the token's. An
 * empty array is a strict commitment and is preserved; only an absent field is
 * omitted.
 *
 * The one field this composer DERIVES rather than carries is the acceptor's
 * `outboundPayloadConsent`: nobody authors it directly, so core's
 * `deriveOutboundPayloadConsent` resolves it from the very `metadata` this
 * document persists, keeping the two from disagreeing. An inviter records none:
 * its own set was authored at mint as `disclosedPayloadColumns` (see
 * docs/spec/EXCHANGE_FILE.md, "The acceptor's outbound consent").
 *
 * Exported so the composition rules stay the tested boundary, even though
 * {@link buildManagedDeposit} is its only caller.
 *
 * @throws {ZodError} if the assembled document fails schema validation (a
 *   malformed locator, an out-of-range port).
 */
export function composeManagedDocument(
  parts: ManagedExchangeDocumentParts,
  connection: WebRTCExchangeLocator,
): ExchangeSpec {
  const outboundPayloadConsent =
    parts.side === "acceptor"
      ? deriveOutboundPayloadConsent(parts.linkageTerms.output, parts.metadata)
      : undefined;
  return composeManagedExchangeFile({
    connection,
    linkageTerms: parts.linkageTerms,
    ...(parts.metadata !== undefined ? { metadata: parts.metadata } : {}),
    ...(parts.standardization !== undefined
      ? { standardization: parts.standardization }
      : {}),
    ...(parts.disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns: parts.disclosedPayloadColumns }
      : {}),
    ...(parts.expectedPayloadColumns !== undefined
      ? { expectedPayloadColumns: parts.expectedPayloadColumns }
      : {}),
    ...(parts.expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate: parts.expectedPartnerDeduplicate }
      : {}),
    ...(outboundPayloadConsent !== undefined ? { outboundPayloadConsent } : {}),
  });
}

/** The operator's choices on the manage offer: the display label and whether to
 * opt into a max-age policy. The schedule is not among them, by design: it is a
 * cadence agreed with the partner out of band, which the operator decides once
 * they have the exchange in front of them, on its own page's local-fields editor
 * (see {@link ./scheduleEntryModel.ts}). */
export interface ManageOfferChoices {
  /** The operator-supplied display label for the partnership. */
  label: string;
  /** The operator's opt-in max-token-age policy in whole days, or `undefined`
   * for the default (no bound). */
  tokenMaxAgeDays?: number;
}

/** Everything a completion surface supplies to turn the offer into a deposit: the
 * parts of this party's document and the locator to compose it from, the
 * invitation's secret, an optional input-file handle where the platform yielded
 * one, and the operator's choices. */
export interface ManagedDepositInputs {
  /** This party's document parts, carrying the deposit's one statement of its
   * `side` (see {@link ManagedExchangeDocumentParts}). */
  documentParts: ManagedExchangeDocumentParts;
  /** The credential-free webrtc locator the document's connection block is
   * composed from (see {@link webrtcLocatorFromEndpoint}). */
  connection: WebRTCExchangeLocator;
  /** The invitation's shared secret -- the inviter's minted `sharedSecret`, the
   * acceptor's `token.sharedSecret`. The one-shot run discards its rotation, so
   * this stays the record's live secret until a managed re-run rotates it. */
  sharedSecret: string;
  /** An input-file handle pointer, where the File System Access API yielded one;
   * absent otherwise (the record field is optional). */
  inputFileHandle?: FileSystemFileHandle;
  /** The operator's label and opt-in max-age policy. */
  choices: ManageOfferChoices;
}

/**
 * Assemble the {@link NewManagedExchange} fields a deposit persists, composing
 * this party's document from `documentParts` here rather than accepting a
 * pre-composed one, so the record's `side` and the document's side-dependent
 * content (the acceptor's `outboundPayloadConsent`) are read from a single
 * stated side and cannot diverge. A record reconstructed from an imported
 * artifact (`managedExchangeImport`) is a separate path, carrying the
 * artifact's own side and document verbatim.
 *
 * The label is carried verbatim -- its cap is enforced by the record schema at
 * the store write ({@link buildManagedExchangeRecord}), with
 * {@link labelWithinCap} as the UI gate.
 *
 * The max-age policy drives `expires`: opting in stamps `now + tokenMaxAgeDays`
 * through {@link rotationWriteBack} (reusing the run-rotate date math); opting
 * out leaves `tokenMaxAgeDays` and `expires` both absent. The invitation's setup
 * lifetime never flows into `expires`, whose provenance is single-source (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` row).
 *
 * @param now The instant the max-age stamp counts from, injected so the deposit
 *   stays pure and testable.
 * @throws {RangeError} (from {@link rotationWriteBack}) if `tokenMaxAgeDays` is
 *   not a positive integer or stamps an expiry outside the representable range.
 * @throws {ZodError} (from {@link composeManagedDocument}) if the composed
 *   document fails schema validation.
 */
export function buildManagedDeposit(
  inputs: ManagedDepositInputs,
  now: number,
): NewManagedExchange {
  const { tokenMaxAgeDays } = inputs.choices;
  const stamp = rotationWriteBack(inputs.sharedSecret, tokenMaxAgeDays, now);
  return {
    label: inputs.choices.label,
    exchangeFile: composeManagedDocument(
      inputs.documentParts,
      inputs.connection,
    ),
    side: inputs.documentParts.side,
    sharedSecret: inputs.sharedSecret,
    ...(inputs.inputFileHandle !== undefined
      ? { inputFileHandle: inputs.inputFileHandle }
      : {}),
    ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
    ...(stamp.expires !== null ? { expires: stamp.expires } : {}),
  };
}

/** Whether the operator's label is within the cap the deposit enforces. Offered
 * so a component can gate its deposit action on a valid label without catching the
 * schema's throw. An empty label is permitted (the field has no minimum); the
 * content guidance -- name the partnership, no sensitive counterparty detail -- is
 * operator cooperation, not enforced. */
export function labelWithinCap(label: string): boolean {
  return label.length <= MAX_LABEL_LENGTH;
}

/**
 * Validate an opted-in max-age day count as the operator typed it (a number, or
 * the string a cleared/partial number input reports), returning the field error
 * to show, or `undefined` when the value is a usable policy. An enabled-but-
 * invalid count must never resolve to "no bound": a cleared field silently
 * converting opt-in to no-bound would deposit an unbounded secret the operator
 * believes is bounded, so an invalid value blocks the deposit instead. The
 * bounds are the record schema's (a positive integer at most
 * {@link MAX_TOKEN_MAX_AGE_DAYS}), checked here so an out-of-range value fails
 * at the field rather than as a generic store-write failure.
 */
export function maxAgeDaysError(value: number | string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return "Enter a whole number of days.";
  if (value > MAX_TOKEN_MAX_AGE_DAYS)
    return `Enter at most ${MAX_TOKEN_MAX_AGE_DAYS} days.`;
  return undefined;
}

/**
 * The cadence line shown when the operator sets a max-age policy, naming the
 * implication the operator weighs against the partnership's known cadence: the
 * exchange must run or be renewed within the bound or its stored secret lapses
 * (see docs/MANAGED_EXCHANGE.md, "Expiry is its own state"). Returns `undefined`
 * when no policy is set (the default), so a component renders nothing.
 */
export function maxAgeCadenceNote(
  tokenMaxAgeDays: number | undefined,
): string | undefined {
  if (tokenMaxAgeDays === undefined) return undefined;
  const days = tokenMaxAgeDays === 1 ? "1 day" : `${tokenMaxAgeDays} days`;
  return `This exchange must run or be renewed within ${days}, or its stored secret lapses and you re-invite your partner.`;
}

/** The operator guidance for the label field: name the partnership without
 * sensitive counterparty detail. Reuses the spec's settled label-row language --
 * the label is disclosed to any reader of the store and never sent, so agreement
 * numbers and contact details do not belong in it. */
export const LABEL_GUIDANCE =
  "Name the partnership so you recognize it later. The label is stored in this browser and never sent, but any reader of this browser's storage can see it, so keep agreement numbers, contact details, and other sensitive counterparty information out of it.";
