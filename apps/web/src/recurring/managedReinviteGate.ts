/**
 * Why the exchange's page is not offering a fresh invitation. Both re-invite
 * controls read these -- the failure recovery's near the top and the
 * configuration section's far below -- so the operator meets the same words
 * whichever one they reached for, and a withheld control says what withheld it
 * rather than sitting inert.
 *
 * The two withhold for different lengths of time. A run in flight is a wait: the
 * control comes back when the run ends, whatever its outcome. A standing
 * compromise response is not waited out -- it ends only when one of the three
 * acts that clear a standing condition clears it (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row).
 */

/**
 * A run of this exchange is under way, so a fresh invitation would replace the
 * secret the run is connecting on. Names the contexts a run can be under way in,
 * because the operator reading this may not be the one who started it.
 */
export const REINVITE_RUN_IN_FLIGHT_REASON =
  "This exchange is running right now -- in this browser, in another tab, or on " +
  "its schedule. A fresh invitation replaces its shared secret, which would " +
  "break the run in progress. When it finishes, re-invite again.";

/**
 * The operator answered a failure gate "something does not add up", so this
 * channel is the one they flagged. Shown where a control was withheld away from
 * the response's own copy, which states the rest of what to do.
 */
export const REINVITE_COMPROMISE_REASON =
  "You answered that something does not add up, so no fresh invitation is " +
  "offered on this channel. Reach your partner on a different trusted channel " +
  "first.";
