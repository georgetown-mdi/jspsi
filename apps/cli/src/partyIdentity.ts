import { UsageError } from "@psilink/core";

import { accountUserName } from "./util/accountUserName";

/** How every refusal here tells the operator to supply the label. */
const IDENTITY_FLAG_HELP = '--identity "name, org, contact"';

/** Why an identity is never invented, stated once for both refusals. */
const PARTNER_READS_IT =
  "The identity is the name your partner reads in the agreed linkage terms";

/**
 * The refusal a command raises when the operator supplied no identity and the
 * account psilink runs as has no user name to fall back on.
 */
export const IDENTITY_REQUIRED =
  "no identity for this party: without --identity, psilink uses the user name " +
  "of the account it runs as, and this account has none -- a container run " +
  "under --user <uid>:<gid> naming a uid the image does not define has no " +
  `entry in the image's user database. ${PARTNER_READS_IT}, so psilink will ` +
  `not stand in one you did not choose: pass ${IDENTITY_FLAG_HELP}.`;

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

/** An identity the operator supplied, or `undefined` for one they did not. */
function supplied(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * This party's identity label for a command that authors its own linkage terms:
 * the `--identity` value, else the user name of the account psilink runs as.
 *
 * A run with neither stops. The label lands in the terms, the invitation, and
 * the disclosure record, where the partner reads it as this party's name, so it
 * is the operator's to choose and there is no placeholder to substitute. The
 * account lookup throws rather than returning nothing when the account has no
 * user-database entry (see `accountUserName`), so its failure is carried as the
 * refusal's cause and the operator still sees what psilink tried.
 */
export function resolveIdentity(identity: string | undefined): string {
  const chosen = supplied(identity);
  if (chosen !== undefined) return chosen;

  let fromAccount: string | undefined;
  let lookupFailure: unknown;
  try {
    fromAccount = supplied(accountUserName());
  } catch (err) {
    lookupFailure = err;
  }
  if (fromAccount !== undefined) return fromAccount;
  throw new UsageError(
    IDENTITY_REQUIRED,
    lookupFailure !== undefined ? { cause: lookupFailure } : undefined,
  );
}

/**
 * This party's identity label for a command that runs an exchange from a saved
 * configuration: the `linkage_terms.identity` it loaded, which `--identity`
 * replaces for the run before this is reached.
 *
 * There is deliberately no account-user-name fallback on this path. The
 * configuration schema requires a non-empty identity, so a configuration
 * carrying none is one the operator has to fix, and running it under the account
 * name would put a label the operator never chose into the agreed terms a
 * partner verifies a signed receipt against.
 */
export function resolveConfiguredIdentity(
  configuredIdentity: string | undefined,
  configPath: string,
): string {
  const chosen = supplied(configuredIdentity);
  if (chosen !== undefined) return chosen;
  throw new UsageError(configuredIdentityRequired(configPath));
}
