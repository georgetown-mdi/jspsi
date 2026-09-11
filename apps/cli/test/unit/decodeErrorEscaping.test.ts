import { expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  UsageError,
} from "@psilink/core";

import { buildErrorEvent } from "../../src/eventStream";
import { decodeAndValidateInvitation } from "../../src/invitationDecode";

// An endpoint key name a malicious inviter can craft, holding every class this
// route has to neutralize: a literal backslash, which one escape doubles and
// two escapes quadruple; a bidi override; and the ESC that drives ANSI
// sequences. Written as explicit escapes -- never pasted glyphs -- so no editor
// or formatter can mangle an invisible literal.
const HOSTILE_ENDPOINT_KEY = "col\x1b[2J\x1b[31m\u202e\\x";

// Builds the token at the wire level, bypassing encodeInvitation: its schema
// validation would refuse a non-locator endpoint field before the fixture
// could be built.
async function encodeRaw(token: unknown): Promise<string> {
  const toBase64Url = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64url");
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(digest).slice(0, 4));
}

const hostileKeyInvitation = (): Promise<string> =>
  encodeRaw({
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "sftp",
      host: "sftp.example",
      path: "/drop",
      [HOSTILE_ENDPOINT_KEY]: "x",
    },
  });

const raisedDecodeError = async (): Promise<UsageError> => {
  const raised = await decodeAndValidateInvitation(
    await hostileKeyInvitation(),
  ).catch((err: unknown) => err);
  expect(raised).toBeInstanceOf(UsageError);
  return raised as UsageError;
};

test("the terminal render escapes a partner-chosen invitation key exactly once", async () => {
  // Driven end to end: the real decode wrapper composes the refusal, and the
  // real renderer -- the boundary every CLI stderr sink routes a caught error
  // through (exitWithError / runOrExit, src/util/exit.ts) -- shows it. A second
  // escape anywhere on that route renders four backslashes for the one the key
  // holds, on the message that tells the operator which key to remove.
  const rendered = sanitizeErrorForDisplay(await raisedDecodeError());
  expect(rendered).toContain(
    `Remove unexpected field(s): ${sanitizeForDisplay(HOSTILE_ENDPOINT_KEY)}`,
  );
});

test("the fd-3 error event escapes the same key exactly once", async () => {
  // The machine channel a supervisor reads takes the same render, so an
  // operator watching the terminal and a supervisor reading fd 3 are told the
  // same key.
  const event = buildErrorEvent(await raisedDecodeError(), "prepare");
  expect(event.message).toContain(
    `Remove unexpected field(s): ${sanitizeForDisplay(HOSTILE_ENDPOINT_KEY)}`,
  );
});

test("no sink receives the partner's key unescaped", async () => {
  // The composed message holds the partner's bytes raw, by design: it is the
  // renderer's input, not a sink. What must hold is that nothing an operator or
  // a supervisor reads holds them.
  const raised = await raisedDecodeError();
  expect(raised.message).toContain(HOSTILE_ENDPOINT_KEY);
  for (const shown of [
    sanitizeErrorForDisplay(raised),
    buildErrorEvent(raised, "prepare").message,
  ]) {
    expect(shown).not.toContain("\u202e");
    expect(shown).not.toContain("\x1b");
  }
});
