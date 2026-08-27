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
 * The refusal {@link resolveConfiguredIdentity} raises, naming the configuration
 * file that was expected to carry the label.
 */
export function configuredIdentityRequired(configPath: string): string {
  return (
    `no identity for this party: ${configPath} carries no ` +
    `linkage_terms.identity. ${PARTNER_READS_IT}, so set it there, or pass ` +
    `${IDENTITY_FLAG_HELP} for this run.`
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
 * This party's identity label for a command that runs an exchange from a saved
 * configuration: the `linkage_terms.identity` it loaded, which `--identity`
 * replaces for the run before this is reached.
 *
 * The configuration schema requires a non-empty identity, so a configuration
 * carrying none is one the operator has to fix; running it under a label they
 * never chose would put that label into the agreed terms a partner verifies a
 * signed receipt against.
 */
export function resolveConfiguredIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  if (configuredIdentity !== undefined && configuredIdentity !== "")
    return configuredIdentity;
  throw new UsageError(configuredIdentityRequired(configPath));
}
