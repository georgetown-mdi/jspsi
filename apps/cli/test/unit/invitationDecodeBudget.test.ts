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

// The encode step without the schema validation encodeInvitation runs first: a
// token carrying a non-locator endpoint field is exactly what that validation
// refuses, so the delivery has to be built at the wire level. A drift between
// this and core's own encoding fails loudly here -- the decode would reject the
// checksum and the rejection under test would never be raised -- rather than
// leaving a stale copy passing.
async function encodeRaw(token: unknown): Promise<string> {
  const toBase64Url = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64url");
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(digest).slice(0, 4));
}

// A partner-crafted invitation whose endpoint carries a field outside the
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

// The sibling of packages/core/test/invitation.test.ts's locator-guidance
// delivery, from the side core cannot reach: that one renders the composition
// the CLI makes by restating its prefix, so a copy edit there -- or first-party
// text added ahead of the guidance -- would leave it green while the shipped
// path overran the link budget. This drives the real decode wrapper instead,
// and reads the guidance off core's own describeDecodeError rather than
// restating any of it.
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
  // of it: the operator is told what a locator may carry and which field to
  // remove, not a prefix of that sentence.
  expect(rendered).toContain(guidance);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  // Not vacuous: the guidance alone outruns the per-value budget, so this fails
  // if the link the CLI composes is ever charged to that one.
  expect(guidance.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
});
