import { afterEach, describe, expect, test, vi } from "vitest";

import { decodeInvitation, getDefaultLinkageTerms } from "@psilink/core";

import {
  ACCEPT_ROUTE_PATH,
  deepLinkFor,
  generateInvitation,
  webrtcEndpointFromLocation,
} from "../../src/psi/invitation.js";

import type { InvitationLocation } from "../../src/psi/invitation.js";

const location: InvitationLocation = {
  origin: "https://example.org:8443",
  hostname: "example.org",
  port: "8443",
};

/** Pull the encoded token out of a deep-link's fragment. */
function tokenFromDeepLink(deepLink: string): string {
  return new URL(deepLink).hash.slice(1);
}

describe("generateInvitation", () => {
  test("round-trips through decodeInvitation with secret, terms, and endpoint intact", async () => {
    const inviterName = "County Health Dept";
    const { encoded } = await generateInvitation({ inviterName, location });

    const token = await decodeInvitation(encoded);

    expect(token.version).toBe("1");
    // The secret is a base64url-encoded 32-byte value (43 chars, last in the
    // padding-constrained set); see SHARED_SECRET_REGEX in core.
    expect(token.sharedSecret).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    // Real terms keyed on the inviter's name, not empty or placeholder.
    expect(token.linkageTerms).toStrictEqual(
      getDefaultLinkageTerms(inviterName),
    );
    expect(token.linkageTerms.identity).toBe(inviterName);
    expect(token.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "webrtc",
      host: "example.org",
      port: 8443,
      path: "/api/",
    });
  });

  test("returns the embedded shared secret so the inviter can derive its id", async () => {
    const { encoded, sharedSecret } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
    });

    // The returned secret is exactly the one inside the encoded token: the
    // inviter derives its rendezvous peer id from it without re-decoding.
    const token = await decodeInvitation(encoded);
    expect(sharedSecret).toBe(token.sharedSecret);
  });

  test("two successive generations yield different secrets (so different derived ids)", async () => {
    const inviterName = "County Health Dept";
    const first = await generateInvitation({ inviterName, location });
    const second = await generateInvitation({ inviterName, location });

    const a = await decodeInvitation(first.encoded);
    const b = await decodeInvitation(second.encoded);

    expect(a.sharedSecret).not.toBe(b.sharedSecret);
    expect(first.encoded).not.toBe(second.encoded);
  });

  test("the deep-link and the bare string decode to identical tokens", async () => {
    const { encoded, deepLink } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
    });

    expect(tokenFromDeepLink(deepLink)).toBe(encoded);
    const fromBare = await decodeInvitation(encoded);
    const fromLink = await decodeInvitation(tokenFromDeepLink(deepLink));
    expect(fromLink).toStrictEqual(fromBare);
  });

  test("the deep-link targets the /accept route with the token in the fragment", async () => {
    const { encoded, deepLink } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
    });

    const url = new URL(deepLink);
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe(ACCEPT_ROUTE_PATH);
    // Token in the fragment, not the query: never sent to the server.
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${encoded}`);
  });

  describe("issues no /api/psi/* (or any) network call", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test("does not fetch when generating an invitation", async () => {
      vi.stubGlobal("fetch", vi.fn());

      await generateInvitation({ inviterName: "County Health Dept", location });

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("webrtcEndpointFromLocation", () => {
  test("normalizes localhost to a loopback literal a peer can dial", () => {
    expect(
      webrtcEndpointFromLocation({ hostname: "localhost", port: "3000" }),
    ).toStrictEqual({
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    });
  });

  test("omits the port for a default-port (empty) location", () => {
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });

  test("drops an out-of-range port rather than encoding a meaningless locator", () => {
    // Port 0 is the OS "assign an ephemeral port" sentinel, never a connect
    // target; the endpoint schema rejects it, so it is not encoded.
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "0" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });

  test("drops a non-numeric port rather than truncating it", () => {
    // Number() yields NaN for "8080abc" (parseInt would truncate to 8080), so a
    // malformed port is omitted, not silently encoded as a wrong locator.
    expect(
      webrtcEndpointFromLocation({ hostname: "example.org", port: "8080abc" }),
    ).toStrictEqual({ channel: "webrtc", host: "example.org", path: "/api/" });
  });
});

describe("deepLinkFor", () => {
  test("places the token in the fragment of the /accept route", () => {
    expect(deepLinkFor("https://example.org", "TOKEN123")).toBe(
      "https://example.org/accept#TOKEN123",
    );
    expect(ACCEPT_ROUTE_PATH).toBe("/accept");
  });
});
