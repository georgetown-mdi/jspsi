import {
  describeDecodeError,
  decodeInvitation,
  isInvitationExpired,
  stripInvitationWhitespace,
  UsageError,
} from "@psilink/core";
import type { InvitationToken } from "@psilink/core";

import { resolveAtSignRefs } from "./util/atSignRefs";

/**
 * Resolve an `@path` reference, strip whitespace a hard-wrapped paste or a
 * wrapped `@`-file leaves inside the token, decode the invitation (verifying
 * the 4-byte checksum and the Zod schema), and reject an expired token by
 * name. All failures raise {@link UsageError} (CLI exit 64).
 *
 * Shared by `accept`'s pre-prompt gate and `exchange --invitation`'s
 * key-file provisioning, so both decode a partner-supplied invitation through
 * one implementation rather than separate copies of a security-sensitive
 * decode path.
 */
export async function decodeAndValidateInvitation(
  rawArg: string,
): Promise<InvitationToken> {
  let encoded: unknown;
  try {
    encoded = resolveAtSignRefs(rawArg);
  } catch (err) {
    throw new UsageError(
      `could not read invitation from ${rawArg}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof encoded !== "string")
    throw new UsageError("invitation must be a string");

  let token: InvitationToken;
  try {
    token = await decodeInvitation(stripInvitationWhitespace(encoded));
  } catch (err) {
    throw new UsageError(
      "invalid invitation string: " + describeDecodeError(err),
    );
  }

  if (isInvitationExpired(token.expires))
    throw new UsageError(
      `invitation expired at ${token.expires}; ask your partner for a new ` +
        "invitation",
    );

  return token;
}
