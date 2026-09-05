import { expect, test } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  decodeInvitation,
  describeDecodeError,
  generateSharedSecret,
  getDefaultLinkageTerms,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";

import { decodeAndValidateInvitation } from "../../src/invitationDecode";

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

// A partner-crafted invitation whose endpoint has a field outside the
// locator allowlist -- the rejection whose fixed guidance is longer than one
// VALUE's display budget.
const nonLocatorInvitation = (): Promise<string> =>
  encodeRaw({
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "sftp",
      host: "sftp.example",
      username: "alice",
    },
  });

// The CLI-side counterpart to packages/core/test/config/invitation.test.ts's
// locator-guidance test: it drives the real decode wrapper and reads the
// guidance from core's own describeDecodeError, rather than restating it.
test("the locator rejection's guidance survives the CLI's own decode composition", async () => {
  const encoded = await nonLocatorInvitation();
  const guidance = describeDecodeError(
    await decodeInvitation(encoded).catch((err: unknown) => err),
  );
  const raised = await decodeAndValidateInvitation(encoded).catch(
    (err: unknown) => err,
  );

  expect(raised).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(raised);
  // Whole, on the error's own message, with whatever the wrapper composed ahead
  // of it: the operator is told what a locator may hold and which field to
  // remove, not a prefix of that sentence.
  expect(rendered).toContain(guidance);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  // The guidance alone exceeds the per-value display budget, so this fails if
  // the CLI's composed link is ever charged against it.
  expect(guidance.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
});
