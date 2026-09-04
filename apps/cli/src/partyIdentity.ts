import { UsageError } from "@psilink/core";

import { promptFreeText, writePromptLine } from "./util/cli";

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
  `Pass ${IDENTITY_FLAG_HELP} naming this party. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * Why a label typed at one invocation cannot stand in for a configured one --
 * the clause every refusal that reads a label out of a configuration file ends
 * on. The file persists unchanged and supplies the terms of every run under the
 * partnership, so a label given for this one invocation would name the party
 * here and leave it named otherwise everywhere after.
 */
const FLAG_CANNOT_STAND_IN =
  `${IDENTITY_FLAG_HELP} cannot stand in, because the configuration persists ` +
  "unchanged and is what every exchange under this partnership sends.";

/**
 * The refusal a command raises when no identity was supplied for a run that
 * authors its own linkage terms.
 */
export const IDENTITY_REQUIRED =
  `no identity for this party: pass ${IDENTITY_FLAG_HELP}. ` +
  `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

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
    `no identity for this party: ${configPath} has no ` +
    `linkage_terms.identity, and it is the source of this invitation's terms. ` +
    `${PARTNER_READS_IT}, so set it there -- ${FLAG_CANNOT_STAND_IN}`
  );
}

/**
 * The refusal {@link resolveKeptConfigurationIdentity} raises, naming the
 * configuration this acceptance keeps as the file that was expected to carry the
 * label.
 *
 * The path composes RAW, for the reason and with the single escape
 * {@link configuredIdentityRequired} documents.
 */
export function keptConfigurationIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} has no ` +
    "linkage_terms.identity, and this acceptance keeps that configuration " +
    `rather than writing one. ${PARTNER_READS_IT}, so set it there -- ` +
    FLAG_CANNOT_STAND_IN
  );
}

/**
 * The refusal both configured-label resolvers raise when the configuration still
 * carries the template placeholder, naming the field to edit and the file it
 * sits in. One wording serves both: the placeholder is refused for the same
 * reason wherever a file supplies the label, and neither command can replace it
 * from the command line.
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
    `organization, and contact -- ${FLAG_CANNOT_STAND_IN}`
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
 * The line shown above either identity question, stating what the label is for.
 * It is the sentence both refusals above end on, so the operator who is asked
 * and the operator who is refused read the same account of it.
 */
export const IDENTITY_PROMPT_PREAMBLE = `${PARTNER_READS_IT}, the invitation, and the disclosure record.`;

/**
 * The question `psilink init` asks. It states what a blank answer does, because
 * blank is not a refusal here: the template is a scaffold to hand-edit, so an
 * operator who has not settled the wording yet gets {@link PLACEHOLDER_IDENTITY}
 * to replace, exactly as a run with no terminal to ask at does.
 */
export const INIT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact), or blank to fill in " +
  "by hand later:";

/**
 * The question `psilink accept` asks. It carries no blank-answer note because
 * blank is absence and an acceptance will not proceed unnamed
 * ({@link IDENTITY_REQUIRED}): it authors a durable partnership the partner
 * reads a name off.
 */
export const ACCEPT_IDENTITY_QUESTION =
  "Identity for this party (name, organization, contact):";

/**
 * Ask for this party's identity at the terminal and return the raw answer.
 *
 * Both lines go to the prompt stream rather than through a logger, so the
 * question and the reason for it are on the terminal whatever `--log-level` and
 * `--log-file` are set to -- the routing the consent surface already takes
 * wherever a prompt follows it. Whether asking is possible at all is the
 * caller's to decide; this only asks.
 */
export function askIdentityAtPrompt(question: string): Promise<string> {
  writePromptLine(IDENTITY_PROMPT_PREAMBLE);
  return promptFreeText(question);
}

/**
 * This party's label from `--identity`, or from a question at the terminal when
 * the flag carried none: the trimmed value, or `undefined` where neither source
 * named this party.
 *
 * Both sources take one treatment, {@link optionalIdentity}'s: trimmed, a blank
 * or whitespace-only value read as absence rather than as a label, and
 * {@link PLACEHOLDER_IDENTITY} refused as neither. A prompt that is answered the
 * way the flag can be misused is therefore refused the way the flag is, and an
 * operator cannot reach a laxer path by typing at the question instead of
 * passing the flag.
 *
 * `ask` is the whole interactivity decision, made by the caller: `undefined`
 * means no question is possible or wanted -- no terminal, an input CSV already
 * holding stdin, an unattended run -- and the flag's answer stands alone, so
 * nothing scripted gains a prompt. The flag is read first either way, so
 * supplying it is what keeps the question from being asked.
 */
export async function identityFromFlagOrPrompt(
  identity: string | undefined,
  ask: (() => Promise<string>) | undefined,
): Promise<string | undefined> {
  const supplied = optionalIdentity(identity);
  if (supplied !== undefined || ask === undefined) return supplied;
  return optionalIdentity(await ask());
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
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    configuredIdentityRequired,
  );
}

/**
 * This party's identity label for an acceptance that keeps the configuration
 * already at the path: that file's own `linkage_terms.identity`.
 *
 * Such an acceptance writes no configuration, so the label it presents has to be
 * the one the kept file carries: `psilink exchange` reads that file for every
 * run the partnership makes, and under `signing.mode: certificate` the label in
 * the agreed terms is what a receipt is verified against -- so a run under any
 * other label would name this party one way for the acceptance and another way
 * for the partnership it belongs to. `--identity` is not an alternative for the
 * same reason it is not one when inviting from a configuration; renaming the
 * party is an edit of that file.
 *
 * Blank and {@link PLACEHOLDER_IDENTITY} are refused, and the value comes back
 * VERBATIM, exactly as {@link resolveInvitationIdentity} treats them and for the
 * reasons recorded there.
 */
export function resolveKeptConfigurationIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  return resolveConfiguredIdentity(
    configuredIdentity,
    configPath,
    keptConfigurationIdentityRequired,
  );
}

/**
 * The body both configured-label resolvers share. `required` is the whole
 * difference between them: why THIS command reads the label out of a file rather
 * than off the command line, which is what its refusal has to say.
 */
function resolveConfiguredIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
  required: (configPath: string) => string,
): string {
  if (configuredIdentity === undefined || configuredIdentity.trim() === "")
    throw new UsageError(required(configPath));
  if (isPlaceholderIdentity(configuredIdentity))
    throw new UsageError(configuredIdentityStillPlaceholder(configPath));
  return configuredIdentity;
}
