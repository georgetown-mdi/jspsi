/**
 * The pure composition of the Tier-2 (unexplained handshake failure) out-of-band
 * confirmation: the forwardable, pre-filled message the operator sends the partner,
 * and the two-outcome gate the partner's reply feeds (see docs/MANAGED_EXCHANGE.md,
 * "Telling a desync from an attack"). Without a grace window the tool cannot
 * cryptographically distinguish a desync from an attack, so the operator -- not the
 * tool -- makes the call out-of-band; this module structures the confirmation so the
 * operator sends a precise message rather than synthesizing prose under stress, and
 * routes the reply through a two-outcome gate rather than a free-form judgment.
 *
 * The message is PLAIN TEXT the operator copies -- no auto-sending -- and it
 * interpolates only THIS record's own local fields (the label and the failure time),
 * never a partner-influenced value: an active impersonator must not be able to steer
 * the message the operator forwards. The three asks are fixed and follow the doc
 * exactly: confirm identity on the out-of-band channel (not just reply), report what
 * the partner's own tool observed and when (a real failure on their side, not
 * inferred from this side's failure alone), and whether they ran from more than one
 * place (an accidental self-fork is indistinguishable from an attack at the other
 * party). The secret-farming caveat is why "did you also see a failure" is not enough:
 * the confirmation must VERIFY a real partner-side failure, never rubber-stamp the
 * benign reading, so an adversary who provokes failures cannot farm an operator who
 * re-invites on autopilot.
 *
 * Pure and platform-free: the copy is composed from record fields, and the gate is a
 * two-value routing decision. The host component renders the message for copying and
 * calls {@link routeConfirmationReply} with the operator's chosen outcome.
 */

import { dateTimeLabel } from "../bench/inviterModel";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The two outcomes the operator picks after the partner replies -- the two-outcome
 * gate, not a free-form judgment. `"confirmed-partner-failure"` is "the partner
 * confirmed a real failure on their side"; `"does-not-add-up"` is "something does not
 * add up" (an unconfirmed identity, no partner-side failure, or a reported second
 * run-place). */
export type ConfirmationOutcome =
  "confirmed-partner-failure" | "does-not-add-up";

/** Where the gate routes each outcome: a confirmed partner-side failure proceeds to
 * fast re-invite; anything that does not add up is treated as compromise and routed to
 * the settled compromise response (notify the partner out-of-band, re-invite),
 * NOT a quiet re-invite. The two share the re-invite ACT but differ in framing and in
 * what the operator does first, so they are distinct routes. */
export type ConfirmationRoute = "reinvite" | "compromise-response";

/** The composed confirmation the Tier-2 surface renders: the forwardable message the
 * operator copies, and the gate's two labeled outcomes. */
export interface ManagedFailureConfirmation {
  /** The pre-filled out-of-band message the operator forwards to the partner, plain
   * text, interpolating only this record's own local fields. */
  message: string;
  /** The label for the "the partner confirmed a real failure on their side" gate
   * option, which routes to fast re-invite. */
  confirmedOption: string;
  /** The label for the "something does not add up" gate option, which routes to the
   * compromise response. */
  doesNotAddUpOption: string;
}

/**
 * Compose the forwardable confirmation message from a record's own local fields. The
 * partnership label (or a neutral fallback when unlabeled) and the failure time are
 * this record's own local values -- never partner-influenced -- so an impersonator
 * cannot steer the message. The three asks are fixed and follow the doc's framing
 * exactly; the message names no benign cause and offers the partner no leading
 * "you also saw a failure, right?" -- it asks the partner to report what their tool
 * observed, so a real partner-side failure is established rather than assumed.
 */
export function composeConfirmationMessage(
  record: ManagedExchangeRecord,
): string {
  const partnership =
    record.label === "" ? "our recurring data exchange" : `"${record.label}"`;
  const when =
    record.lastRun !== undefined
      ? dateTimeLabel(new Date(record.lastRun.at))
      : undefined;
  const failedLine =
    when !== undefined
      ? `A scheduled run of ${partnership} failed to authenticate on my side on ${when}.`
      : `A scheduled run of ${partnership} failed to authenticate on my side.`;
  return [
    failedLine,
    "",
    "Before I re-establish the connection, I need to confirm this was an ordinary",
    "problem on your side and not someone impersonating one of us. Please reply on",
    "this channel and:",
    "",
    "1. Confirm it is really you -- say something only you and I would know, not just",
    "   reply to this message.",
    "2. Tell me what your own psilink reported, and when. I need to know a real",
    "   failure happened on your side, not just that mine failed.",
    "3. Tell me whether you have run this exchange from more than one place -- a second",
    "   browser or profile, another device, or a restored backup. That can cause this",
    "   without anyone attacking us, and it is the only way we can tell.",
    "",
    "Once you confirm all three, I will send a fresh invitation to reconnect.",
  ].join("\n");
}

/**
 * Compose the full Tier-2 confirmation for a record: the forwardable message and the
 * gate's two labeled outcomes. The option labels are fixed copy; the message is the
 * record's own (see {@link composeConfirmationMessage}).
 */
export function composeManagedFailureConfirmation(
  record: ManagedExchangeRecord,
): ManagedFailureConfirmation {
  return {
    message: composeConfirmationMessage(record),
    confirmedOption:
      "My partner confirmed their identity and a real failure on their side",
    doesNotAddUpOption: "Something does not add up",
  };
}

/**
 * Route the partner's reply through the two-outcome gate: a confirmed real
 * partner-side failure proceeds to fast re-invite; anything that does not add up is
 * treated as compromise and routed to the compromise response. This is the whole gate
 * -- there is deliberately no third "maybe" outcome, because the honest posture is
 * that an unconfirmed reply is a compromise until proven otherwise.
 */
export function routeConfirmationReply(
  outcome: ConfirmationOutcome,
): ConfirmationRoute {
  return outcome === "confirmed-partner-failure"
    ? "reinvite"
    : "compromise-response";
}

/** The compromise-response copy the "something does not add up" leg shows: it names
 * the settled compromise response -- stop, do not re-invite on this channel, treat the
 * exchange's secret as exposed -- and points at the operator's usual security process.
 * It invents no new security guidance; it states the doc's framing for a suspected
 * compromise and stops. Owner-reviewed copy. */
export const COMPROMISE_RESPONSE_TITLE = "Treat this as a possible compromise";

export const COMPROMISE_RESPONSE_MESSAGE =
  "Because your partner could not confirm a genuine failure on their side, treat " +
  "this exchange's secret as exposed. Do not re-invite on the channel you just " +
  "used - a fresh invitation there would hand a new secret to whoever is " +
  "interfering. Stop, and follow your organization's process for a suspected " +
  "compromise: reach your partner through a different trusted channel to confirm " +
  "what happened before re-establishing this exchange.";
