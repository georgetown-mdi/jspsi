/**
 * The pure decision half of the "manage this exchange" offer the bench makes at
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
 * is skipped and the one-shot flow's discard stands, so there is deliberately no
 * "compose then throw away" path here -- a caller that declines never composes.
 */

import { MAX_TOKEN_MAX_AGE_DAYS } from "@psilink/core";

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
 * Either is already the invitation's `WebRTCEndpointSchema` shape (host/port/path,
 * no credential), and the locator IS that schema (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection block") -- so this only
 * re-shapes it, dropping an absent optional rather than carrying an explicit
 * `undefined` the composer's strict parse would otherwise reject.
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
   * consented to and locked in, never a re-derivation that could drift from it).
   * Empty means a strict "sends nothing" commitment; absent means no commitment
   * on record (the acceptor, whose send commitment rides its mirrored
   * `payload.send` instead -- see docs/spec/FILE_SYNC.md, "Which mint paths
   * persist disclosedPayloadColumns").
   */
  disclosedPayloadColumns?: Array<string>;
  /**
   * This party's RECEIVE-side lock-in -- the acceptor supplies the invitation
   * token's `disclosedPayloadColumns` (the partner's committed send set, in the
   * partner's column namespace), so a managed re-run fails CLOSED if the partner
   * transmits a different set than was consented to at accept, exactly as the
   * CLI accept persists it (docs/spec/FILE_SYNC.md, "Runtime lock-in"). Empty
   * means a strict "receive nothing" lock-in; absent means lazy (a token that
   * carried no set). The inviter omits it: its received set is unknowable at
   * mint (the CLI inviter crystallizes it only by observing the first exchange).
   */
  expectedPayloadColumns?: Array<string>;
}

/**
 * Compose this party's persisted exchange-file document from its own document
 * parts and the credential-free webrtc locator. The payload-column commitments
 * are caller-supplied and carried verbatim -- `disclosedPayloadColumns` is the
 * token's published set (the inviter's send commitment), and
 * `expectedPayloadColumns` is the token's set from the partner's side (the
 * acceptor's receive lock-in) -- never re-derived here, so the persisted
 * commitment cannot disagree with the one the token carried. An empty array is
 * a strict commitment and is preserved; only an absent field is omitted. The
 * document carries no `authentication` block and no credential by construction
 * (see {@link composeManagedExchangeFile}).
 *
 * @throws {ZodError} if the assembled document fails schema validation (a
 *   malformed locator, an out-of-range port).
 */
export function composeManagedDocument(
  parts: ManagedExchangeDocumentParts,
  connection: WebRTCExchangeLocator,
): ExchangeSpec {
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
  });
}

/** The operator's choices on the manage offer: the display label and whether to
 * opt into a max-age policy. The schedule is a later surface (a managed re-run
 * item), so it is deliberately not offered here. */
export interface ManageOfferChoices {
  /** The operator-supplied display label for the partnership. */
  label: string;
  /** The operator's opt-in max-token-age policy in whole days, or `undefined`
   * for the default (no bound). */
  tokenMaxAgeDays?: number;
}

/** Everything a completion surface supplies to turn the offer into a deposit: the
 * party's side, its composed document, the invitation's secret, an optional
 * input-file handle where the platform yielded one, and the operator's choices. */
export interface ManagedDepositInputs {
  /** This party's side of the partnership. */
  side: ManagedExchangeSide;
  /** This party's composed exchange-file document (see
   * {@link composeManagedDocument}). */
  exchangeFile: ExchangeSpec;
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
 * Assemble the {@link NewManagedExchange} fields a deposit persists. The label is
 * carried verbatim -- its cap is enforced by the record schema at the store write
 * ({@link buildManagedExchangeRecord}), with {@link labelWithinCap} as the UI
 * gate. The max-age policy drives `expires`: when the operator opts in, `expires`
 * is stamped `now + tokenMaxAgeDays` through {@link rotationWriteBack} (reusing
 * the run-rotate date math and its guards, not duplicating them), so a
 * creation-time bound is applied exactly as a rotation would restamp it; when
 * they do not, `tokenMaxAgeDays` and `expires` are both absent -- the opt-in
 * default. The invitation's setup lifetime never flows into `expires`: the
 * record's `expires` provenance is single-source (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` row).
 *
 * @param now The instant the max-age stamp counts from, injected so the deposit
 *   stays pure and testable.
 * @throws {RangeError} (from {@link rotationWriteBack}) if `tokenMaxAgeDays` is
 *   not a positive integer or stamps an expiry outside the representable range.
 */
export function buildManagedDeposit(
  inputs: ManagedDepositInputs,
  now: number,
): NewManagedExchange {
  const { tokenMaxAgeDays } = inputs.choices;
  const stamp = rotationWriteBack(inputs.sharedSecret, tokenMaxAgeDays, now);
  return {
    label: inputs.choices.label,
    exchangeFile: inputs.exchangeFile,
    side: inputs.side,
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
 * to show, or `undefined` when the value is a usable policy. The offer must not
 * resolve an enabled-but-invalid count to "no bound": the max-age policy is the
 * only control bounding a dormant partnership's stored-secret exposure, so a
 * cleared field silently converting opt-in to no-bound would deposit an unbounded
 * secret the operator believes is bounded -- an invalid value blocks the deposit
 * with this error instead. The bounds are the record schema's (a positive integer
 * at most {@link MAX_TOKEN_MAX_AGE_DAYS}), checked here so an out-of-range value
 * fails at the field, not as a generic store-write failure after the click.
 */
export function maxAgeDaysError(value: number | string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return "Enter a whole number of days.";
  if (value > MAX_TOKEN_MAX_AGE_DAYS)
    return `Enter at most ${MAX_TOKEN_MAX_AGE_DAYS} days.`;
  return undefined;
}

/**
 * The cadence line surfaced when the operator sets a max-age policy, naming the
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
