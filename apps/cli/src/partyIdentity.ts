import { UsageError } from "@psilink/core";

/** How every refusal here tells the operator to supply the label. */
const IDENTITY_FLAG_HELP = '--identity "name, org, contact"';

/** Why an identity is never invented, stated once for both refusals. */
const PARTNER_READS_IT =
  "The identity is the name your partner reads in the agreed linkage terms";

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
 */
export function resolveIdentity(identity: string | undefined): string {
  const chosen = identity?.trim() ?? "";
  if (chosen.length === 0) throw new UsageError(IDENTITY_REQUIRED);
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
 */
export function optionalIdentity(
  identity: string | undefined,
): string | undefined {
  const chosen = identity?.trim() ?? "";
  return chosen.length === 0 ? undefined : chosen;
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
  if (configuredIdentity !== undefined && configuredIdentity.trim() !== "")
    return configuredIdentity;
  throw new UsageError(configuredIdentityRequired(configPath));
}
