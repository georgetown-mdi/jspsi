import { vi } from "vitest";

import {
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  type ConnectionEndpoint,
  type InvitationToken,
  type LinkageTerms,
} from "@alcove/core";

import { displayInvitation } from "../src/invitationDisplay";
import { generateSharedSecret } from "../src/onlineBootstrap";

// The columns satisfying the sample invitation's linkage keys, none of which is
// disclosed to the partner (inferMetadata gives a recognized linkage alias
// is_payload: false), so a CSV of these alone sends nothing.
export const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

/**
 * The built-in rule set narrowed to the keys {@link LINKAGE_COLUMNS} supports, the
 * way a party's own file narrows it. Every terms fixture accept.test.ts and
 * invitationDisplay.test.ts build uses it, on both sides: an acceptance is
 * refused unless its CSV can satisfy every key the invitation declares, so terms
 * declaring a key no test CSV here holds would refuse every acceptance below.
 */
export function sampleTerms(identity: string): LinkageTerms {
  return getDefaultLinkageTerms(identity, inferMetadata(LINKAGE_COLUMNS, []));
}

/** An expiry an hour past the current time, always in the invitation's future. */
export const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

/** A minimal, schema-valid invitation token for the given expiry and endpoint. */
export function sampleToken(
  expires?: string,
  connectionEndpoint?: ConnectionEndpoint,
): InvitationToken {
  return {
    version: "1",
    linkageTerms: sampleTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires,
    connectionEndpoint,
  };
}

/**
 * Encodes a token WITHOUT schema validation (encodeInvitation would reject a
 * malicious token), reproducing decodeInvitation's checksum + base64url framing
 * so the decode path runs on attacker-shaped input.
 */
export async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

/**
 * Renders displayInvitation into the joined info-log output, through the same
 * log-writing sink the unattended path renders to and spying on the given logger
 * so each test can assert against its own logger instance. The acceptor's own
 * outbound-send set defaults to undefined (the not-yet-known case), so a test
 * exercising an unrelated line need not supply one.
 */
export function renderDisplayInvitation(
  log: ReturnType<typeof getLogger>,
  token: InvitationToken,
  ownOutboundSend?: ReadonlyArray<string>,
  promptFollows = true,
): string {
  const infoSpy = vi.spyOn(log, "info");
  try {
    displayInvitation({
      token,
      ownOutboundSend,
      emit: (line) => {
        log.info(line);
      },
      promptFollows,
    });
    return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    infoSpy.mockRestore();
  }
}

// The display's marked label for the acceptor's own outbound-send columns,
// spelled out rather than derived from CONSENT_FACTS, so a marker that silently
// changed vocabulary reddens the assertions using it instead of following the
// table.
export const OUTBOUND_SEND_LABEL = "columns you will send (enforced)";

// The two headings the repeated decision block can sit under. Only the framing
// differs: a prompt follows on one path and nothing does on the other.
export const REPEAT_HEADING = "Before you accept, repeated from above:";
export const REPEAT_HEADING_UNATTENDED = "Repeated from above:";
