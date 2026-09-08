/**
 * The one copy for a control over THIS party's own `deduplicate`, shared by
 * the two seats that offer it: the accept screen's terms review
 * ({@link ../components/InvitationTerms}) and the console's Direct-exchange
 * confirm screen ({@link ../exchange/DirectConfirmSection}).
 *
 * The label and description name no party role, so the one wording reads at a
 * seat holding an invitation and at one holding neither party's. What the
 * value discloses is stated by core's own consent copy beside the control at
 * each seat, not here: the two seats know different amounts about the pair --
 * the accept seat reads the partner's declared value from the invitation, the
 * direct seat cannot -- and a shared sentence would have to overstate one of
 * them.
 */

/** The label the control is offered under: what setting it turns on, from the
 * declaring party's own side. */
export const DEDUPLICATE_CONTROL_LABEL =
  "Let several of my records match one of my partner's";

/** What leaving it off means, as the control's own description. */
export const DEDUPLICATE_CONTROL_DESCRIPTION =
  "Your own side of this setting. Leave it off and each of your records " +
  "matches at most one of your partner's.";
