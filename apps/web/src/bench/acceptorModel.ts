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

/** The acceptor's three spine steps, in order -- the steps the rail walks. */
export type AcceptorSpineStepName = "review" | "consent" | "columns";

/** The acceptor's working states: the three spine steps plus the terminal `launched`
 * state the columns step commits to (a minimal run stub the next package replaces).
 * `launched` is not a spine step -- the rail switches to the run timeline there. */
export type AcceptorStep = AcceptorSpineStepName | "launched";

/** The spine step labels, exactly as the mockup names them. */
export const ACCEPTOR_STEP_LABELS: Record<AcceptorSpineStepName, string> = {
  review: "Review terms",
  consent: "Consent & your file",
  columns: "Confirm your columns",
};

/** The spine order the rail renders and the step-state derivation walks. */
export const ACCEPTOR_STEP_ORDER: ReadonlyArray<AcceptorSpineStepName> = [
  "review",
  "consent",
  "columns",
];

/** One derived spine entry: the step's label, its position state, and whether it
 * is navigable back (a done step is, per the mockup's done-steps-are-links
 * rule). */
export interface AcceptorSpineStep {
  step: AcceptorSpineStepName;
  label: string;
  state: RailStepState;
  navigable: boolean;
}

/**
 * Derive the spine's done/current/pending states for the step the acceptor is
 * on: steps before the current one are done (and navigable back), the current
 * one is current, and later ones are pending -- the inviterModel spine pattern,
 * over the acceptor's fixed three-step order. Only the spine steps are passed; the
 * terminal `launched` state swaps the rail for the run timeline instead.
 */
export function acceptorSpine(
  current: AcceptorSpineStepName,
): Array<AcceptorSpineStep> {
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

/** The Customize group's single fact: a Cleaning tab whose value is the em-dash
 * placeholder until the columns step surfaces a reason to review cleaning
 * (silent-empty fields, dead keys, invalid steps), then an amber attention value
 * naming the count. Renders like the inviter's quiet facts. `attention` is the
 * derived fact string (undefined -> em-dash); its presence colors the row amber. */
export function acceptorRailFacts(attention?: string): Array<RailFact> {
  return [
    {
      label: "Cleaning",
      fact: attention,
      tone: attention === undefined ? undefined : "attention",
    },
  ];
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

/** The step-3 ledger footer, swapped in on the columns step: local-only column
 * typing and cleaning, stated exactly as the mockup. */
export const ACCEPTOR_COLUMNS_LEDGER_FOOTER =
  "Column typing and cleaning stay on your device. Your partner sees matches, " +
  "never these settings.";

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
