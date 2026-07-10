import { sanitizeForDisplay } from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";
import { summarizeInvitation } from "@psi/invitationSummary";

import { dateTimeLabel } from "./inviterModel";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

import type { RailFact, RailStepState } from "./Rail";

/**
 * The pure model behind the acceptor bench's three-step spine: the step
 * progression the rail walks, the disclosure ledger built from the decoded
 * invitation's terms, the single Customize fact, and the consent-gate helper
 * the consent step submits through. No React and no I/O -- the tested boundary
 * for "the spine derives done/current/pending", "the ledger mirrors the
 * inviter's proposal", and "the consent gate blocks until both the checkbox and
 * a non-empty name are supplied". Every partner-controlled string reaches the
 * ledger through {@link summarizeInvitation}, the one sanitizing boundary, so
 * the model never re-derives that escaping.
 */

/** The acceptor spine's three steps, in order. `columns` is the confirm step a
 * later package fills; this slice stubs it. */
export type AcceptorStep = "review" | "consent" | "columns";

/** The spine step labels, exactly as the mockup names them. */
export const ACCEPTOR_STEP_LABELS: Record<AcceptorStep, string> = {
  review: "Review terms",
  consent: "Consent & your file",
  columns: "Confirm your columns",
};

/** The spine order the rail renders and the step-state derivation walks. */
export const ACCEPTOR_STEP_ORDER: ReadonlyArray<AcceptorStep> = [
  "review",
  "consent",
  "columns",
];

/** One derived spine entry: the step's label, its position state, and whether it
 * is navigable back (a done step is, per the mockup's done-steps-are-links
 * rule). */
export interface AcceptorSpineStep {
  step: AcceptorStep;
  label: string;
  state: RailStepState;
  navigable: boolean;
}

/**
 * Derive the spine's done/current/pending states for the step the acceptor is
 * on: steps before the current one are done (and navigable back), the current
 * one is current, and later ones are pending -- the inviterModel spine pattern,
 * over the acceptor's fixed three-step order.
 */
export function acceptorSpine(current: AcceptorStep): Array<AcceptorSpineStep> {
  const currentPosition = ACCEPTOR_STEP_ORDER.indexOf(current);
  return ACCEPTOR_STEP_ORDER.map((step, position) => {
    const state: RailStepState =
      position < currentPosition
        ? "done"
        : position === currentPosition
          ? "current"
          : "pending";
    return {
      step,
      label: ACCEPTOR_STEP_LABELS[step],
      state,
      navigable: state === "done",
    };
  });
}

/** The Customize group's single fact for this slice: a Cleaning tab whose value
 * is the em-dash placeholder until the columns package wires its attention
 * state. Renders like the inviter's quiet facts. */
export function acceptorRailFacts(): Array<RailFact> {
  return [{ label: "Cleaning" }];
}

/**
 * Result direction phrased from the ACCEPTOR's seat, mirroring the inviter's
 * `output`: `expectsOutput` is whether the inviter receives, `shareWithPartner`
 * whether the acceptor (its partner) receives -- so from the acceptor's side the
 * two roles swap.
 */
function acceptorResultsGoTo(output: LinkageTerms["output"]): string {
  const acceptorReceives = output.shareWithPartner;
  const inviterReceives = output.expectsOutput;
  if (acceptorReceives && inviterReceives) return "You and your partner";
  if (acceptorReceives) return "Only you";
  if (inviterReceives) return "Only your partner";
  return "Neither party";
}

/** One row of the acceptor's disclosure ledger: the value renders in the data
 * voice, `muted` in the empty-state voice, `value` may be a multi-line list (the
 * per-key matched-on rows). */
export interface AcceptorLedgerRow {
  label: string;
  value?: string | ReadonlyArray<string>;
  muted?: string;
}

/** The trust line under the acceptor's ledger, stated exactly as the mockup. */
export const ACCEPTOR_LEDGER_FOOTER =
  "These terms are your partner's proposal, read-only. Accepting never sends " +
  "more than this ledger names.";

/** The ledger tag naming who proposed the terms, with the partner's
 * self-asserted name sanitized for display. */
export function acceptorLedgerTag(invitingParty: string): string {
  return `Proposed by ${invitingParty}`;
}

/**
 * The acceptor's disclosure ledger, read from the decoded invitation's terms:
 * what the acceptor sends and receives, the per-key matched-on list, the absolute
 * expiry, where the results go, the agreement reference, and the browser
 * transport. Every partner string is sanitized by {@link summarizeInvitation}.
 * The proposal is read-only here -- there is nothing to edit -- so the rows never
 * carry a spine-step reference.
 */
export function acceptorLedgerRows(
  token: InvitationToken,
): Array<AcceptorLedgerRow> {
  const summary = summarizeInvitation(token);
  // What the acceptor sends is the inviter's egress request of it
  // (summary.payload.receive). An empty or undeclared request sends no extra
  // columns beyond the matching fingerprints.
  const sent = summary.payload?.receive ?? [];
  // What the acceptor receives for matched records is the inviter's send set
  // (summary.payload.send), which derives from the carried disclosedPayloadColumns.
  const received = summary.payload?.send ?? [];
  return [
    sent.length > 0
      ? { label: "You will send", value: sent.join(", ") }
      : { label: "You will send", muted: "No additional columns" },
    {
      label: "You will receive",
      value:
        received.length > 0
          ? `Matched rows + ${received.join(", ")}`
          : "Matched rows",
    },
    summary.linkageKeys.length > 0
      ? {
          label: "Matched on",
          value: summary.linkageKeys.map(
            (key, index) => `${index + 1}. ${key.name}`,
          ),
        }
      : { label: "Matched on", muted: "No keys" },
    {
      label: "Expires",
      value:
        summary.expires !== undefined
          ? dateTimeLabel(new Date(summary.expires))
          : "No expiry",
    },
    {
      label: "Results go to",
      value: acceptorResultsGoTo(token.linkageTerms.output),
    },
    summary.legalAgreement !== undefined
      ? { label: "Agreement", value: summary.legalAgreement.reference }
      : { label: "Agreement", muted: "None" },
    { label: "Transport", value: "Browser" },
  ];
}

/** The invitation heading names the partner: the same sanitized identity the
 * ledger tag uses, so the two surfaces cannot disagree. */
export function invitingPartyName(token: InvitationToken): string {
  return sanitizeForDisplay(token.linkageTerms.identity);
}

/**
 * The consent gate the consent step submits through: {@link commitAcceptance}
 * returns the trimmed name to record only when the checkbox is checked AND a
 * non-empty name is given, else undefined. Never a reimplementation of that rule
 * -- the extensively-hardened gate stays the one authority, consulted here for
 * both the submit's disabled state and the handler's re-check.
 */
export function acceptorConsentName(input: {
  consented: boolean;
  name: string;
}): string | undefined {
  return commitAcceptance(input);
}

/** Whether the consent gate is satisfied -- the consent step's submit-disabled
 * predicate, derived from the same gate the handler re-checks. */
export function acceptorConsentReady(input: {
  consented: boolean;
  name: string;
}): boolean {
  return acceptorConsentName(input) !== undefined;
}
