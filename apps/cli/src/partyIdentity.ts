import { UsageError } from "@psilink/core";

/** How every refusal here tells the operator to supply the label. */
const IDENTITY_FLAG_HELP = '--identity "name, org, contact"';

/** Why an identity is never invented, stated once for both refusals. */
const PARTNER_READS_IT =
  "The identity is the name your partner reads in the agreed linkage terms";

/**
 * The identity `psilink init` writes into a fresh template when the run gives it
 * no `--identity`, and the one string no resolver here accepts. It lives beside
 * the resolvers rather than beside the template writer that emits it so the
 * value written and the value refused are a single definition.
 *
 * It has to be non-empty for the template to parse -- the linkage-terms schema
 * gives identity a one-character minimum -- which is exactly why nothing else
 * catches it: it is a well-formed label, and only knowing this specific string
 * distinguishes it from a name the operator chose.
 */
export const PLACEHOLDER_IDENTITY = "REPLACE_WITH_YOUR_IDENTITY";

/**
 * Whether a value is that placeholder standing where a name belongs.
 *
 * The comparison is whole-string against the trimmed value, so a label that
 * merely contains this text, or differs from it in case, is a name like any
 * other: only the string the template writes, alone on the field, is refused.
 */
function isPlaceholderIdentity(identity: string): boolean {
  return identity.trim() === PLACEHOLDER_IDENTITY;
}

/**
 * The refusal every `--identity` path raises when the flag carries the template
 * placeholder rather than a name.
 */
export const IDENTITY_STILL_PLACEHOLDER =
  `"${PLACEHOLDER_IDENTITY}" is the placeholder psilink init writes where a ` +
  "name belongs, so it is refused exactly as no identity at all. " +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record, so it is ` +
  `yours to choose: pass ${IDENTITY_FLAG_HELP} naming this party.`;

/**
 * The refusal a command raises when no identity was supplied for a run that
 * authors its own linkage terms.
 */
export const IDENTITY_REQUIRED =
  "no identity for this party: psilink was given none and invents none. " +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record, so it is ` +
  `yours to choose: pass ${IDENTITY_FLAG_HELP}.`;

/**
 * The refusal {@link resolveInvitationIdentity} raises, naming the configuration
 * file that was expected to carry the label.
 *
 * The path composes RAW, as every fragment interpolated into an `Error` does:
 * `sanitizeErrorForDisplay` escapes and redacts the whole rendered chain once,
 * where the CLI shows it. Escaping here as well would escape it twice -- a
 * Windows path's every backslash reaching the operator quadrupled -- which is
 * what the sibling `--identity` warning in `commands/invite.ts` does NOT do
 * either: that one goes to a `log` sink, its own display boundary, and so escapes
 * there. See CONTRIBUTING.md, Operator-facing escaping.
 */
export function configuredIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} carries no ` +
    `linkage_terms.identity, and it is the source of this invitation's terms. ` +
    `${PARTNER_READS_IT}, so set it there -- ${IDENTITY_FLAG_HELP} cannot ` +
    "stand in, because the configuration persists unchanged and is what every " +
    "exchange under this partnership sends."
  );
}

/**
 * The refusal {@link resolveInvitationIdentity} raises when the configuration
 * still carries the template placeholder, naming the field to edit and the file
 * it sits in.
 *
 * The path composes RAW, for the reason and with the single escape
 * {@link configuredIdentityRequired} documents.
 */
export function configuredIdentityStillPlaceholder(configPath: string): string {
  return (
    `linkage_terms.identity in ${configPath} is still ` +
    `"${PLACEHOLDER_IDENTITY}", the placeholder psilink init writes where a ` +
    "name belongs, so it is refused exactly as an absent one. " +
    `${PARTNER_READS_IT}, so replace it there with this party's name, ` +
    `organization, and contact -- ${IDENTITY_FLAG_HELP} cannot stand in, ` +
    "because the configuration persists unchanged and is what every exchange " +
    "under this partnership sends."
  );
}

/**
 * This party's identity label for a command that authors its own linkage terms:
 * the `--identity` value, trimmed, and nothing else.
 *
 * There is no fallback of any kind, so this reads no system state and a run
 * without the flag stops. The label lands in the terms, the invitation, and the
 * disclosure record, where the partner reads it as this party's name, so it is
 * the operator's to choose: the account psilink runs as is not a name they
 * chose (in the published image it is the image's own), and a blank value --
 * what `--identity "$ORG"` sends with `ORG` unset -- is a run that meant to
 * name this party and did not.
 *
 * {@link PLACEHOLDER_IDENTITY} is refused alongside blank: it is a name only in
 * the sense that the schema accepts it, and a run under it would send the words
 * asking for a name as this party's own.
 */
export function resolveIdentity(identity: string | undefined): string {
  const chosen = identity?.trim() ?? "";
  if (chosen.length === 0) throw new UsageError(IDENTITY_REQUIRED);
  if (isPlaceholderIdentity(chosen))
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * This party's identity label for a run that may go unnamed: the `--identity`
 * value, trimmed, or `undefined` where the flag names nothing.
 *
 * A blank value is absence rather than a label: it is what a scripted
 * `--identity "$ORG"` sends with `ORG` unset, and an empty string is not a name
 * the terms schema would accept. Absence is carried through as absence -- the
 * terms simply hold no identity, and psilink substitutes nothing for it.
 *
 * {@link PLACEHOLDER_IDENTITY} is refused instead, the only value this rejects:
 * it is neither a label nor absence. Read as a label it would name this party
 * the words asking for its name, and read as absence it would silently unname a
 * run whose operator typed a value believing it named them -- on the runs that
 * take this resolver, leaving whatever the configuration carries standing.
 */
export function optionalIdentity(
  identity: string | undefined,
): string | undefined {
  const chosen = identity?.trim() ?? "";
  if (chosen.length === 0) return undefined;
  if (isPlaceholderIdentity(chosen))
    throw new UsageError(IDENTITY_STILL_PLACEHOLDER);
  return chosen;
}

/**
 * This party's identity label for an invitation minted from a saved
 * configuration: the `linkage_terms.identity` that configuration carries.
 *
 * Inviting is a ceremony interface -- it authors a durable partnership the
 * partner reads a name off, in the invitation and in every exchange that follows
 * -- so it is one of the two commands that will not proceed unnamed, and this is
 * that refusal for the path whose label comes from a file rather than a flag.
 * `--identity` is not an alternative here: the configuration persists unchanged
 * and supplies the terms of every later run, so a label given for this one
 * invocation would leave the partnership named in the invitation and unnamed
 * everywhere after it.
 *
 * A whitespace-only value takes the same refusal, on the same reading of blank
 * the `--identity` paths take: the schema's `.min(1)` admits it, and it would
 * otherwise mint an invitation whose inviter heading renders empty -- named as
 * far as every check is concerned and nameless to the partner reading it.
 * {@link PLACEHOLDER_IDENTITY} is refused for the same reason and at the same
 * point: the operator edited the file and passed over this field, and the
 * invitation would go out -- certificate mode included -- naming the party the
 * template's own instruction to name it.
 *
 * What comes back is the configured value VERBATIM, trimmed or not. Trimming
 * only decides whether this refuses; the label the partnership actually sends is
 * the configuration's own bytes, which every later `psilink exchange` reads
 * straight from the file, and a certificate authorizes an exact identity string.
 * Returning a trimmed copy would name the partnership one way in the invitation
 * and another in every run under it.
 */
export function resolveInvitationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  if (configuredIdentity === undefined || configuredIdentity.trim() === "")
    throw new UsageError(configuredIdentityRequired(configPath));
  if (isPlaceholderIdentity(configuredIdentity))
    throw new UsageError(configuredIdentityStillPlaceholder(configPath));
  return configuredIdentity;
}
