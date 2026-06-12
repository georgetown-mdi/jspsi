import { afterEach, describe, expect, test, vi } from "vitest";

import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  decodeInvitation,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  ACCEPT_ROUTE_PATH,
  deepLinkFor,
  generateInvitation,
  webrtcEndpointFromLocation,
} from "../../src/psi/invitation.js";
import { prepareAcceptedInvitation } from "../../src/psi/acceptInvitation.js";

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

describe("generateInvitation expiry", () => {
  /**
   * Read the token's `expires` as epoch ms, asserting it is present. The
   * generator measures the lifetime from its own `Date.now()` (not an injected
   * clock -- encodeInvitation re-checks `expires` against the live clock, so a
   * second injectable clock could not be honored), so callers bracket the call
   * with their own before/after window rather than assert an exact instant.
   */
  async function expiresMsOf(encoded: string): Promise<number> {
    const token = await decodeInvitation(encoded);
    expect(token.expires).toBeDefined();
    return new Date(token.expires ?? "").getTime();
  }

  test("mints a non-empty `expires`, one hour (the default) ahead of generation", async () => {
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
    });
    const after = Date.now();

    // The generation instant lies in [before, after], so the default-lifetime
    // expiry lies in that window shifted forward by one hour.
    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = INVITATION_LIFETIME_SECONDS * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("an explicit lifetimeSeconds sets `expires` to that many seconds ahead", async () => {
    const lifetimeSeconds = 30 * 60;
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
      lifetimeSeconds,
    });
    const after = Date.now();

    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = lifetimeSeconds * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("rejects a non-positive (or non-finite) lifetimeSeconds at entry, before encoding", async () => {
    // Caught here with a clear cause rather than at encodeInvitation's
    // future-expiry backstop.
    for (const lifetimeSeconds of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        generateInvitation({
          inviterName: "County Health Dept",
          location,
          lifetimeSeconds,
        }),
      ).rejects.toThrow(/positive number of seconds/i);
    }
  });

  test("rejects a lifetimeSeconds past the one-year ceiling, before encoding", async () => {
    // The seam must not be able to mint an effectively-permanent token, so a
    // value past the ceiling is rejected up front with the bound's own cause.
    await expect(
      generateInvitation({
        inviterName: "County Health Dept",
        location,
        lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS + 1,
      }),
    ).rejects.toThrow(/must not exceed/i);
  });

  test("accepts a lifetimeSeconds exactly at the ceiling", async () => {
    // The bound is inclusive: one year to the second is allowed.
    const before = Date.now();
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
      lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS,
    });
    const after = Date.now();

    const expiresMs = await expiresMsOf(encoded);
    const lifetimeMs = MAX_INVITATION_LIFETIME_SECONDS * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + lifetimeMs);
    expect(expiresMs).toBeLessThanOrEqual(after + lifetimeMs);
  });

  test("the minted token is honored by the acceptor before expiry and rejected at it", async () => {
    // The two sides must agree on the same `expires` semantics: the inviter sets
    // the bound here, and prepareAcceptedInvitation (the acceptor) enforces it.
    // Read the actual minted expiry rather than recompute it, since the generator
    // measures from its own clock.
    const { encoded } = await generateInvitation({
      inviterName: "County Health Dept",
      location,
    });
    const expiresAt = new Date(await expiresMsOf(encoded));

    // A second before expiry: the acceptor proceeds to the WebRTC endpoint.
    await expect(
      prepareAcceptedInvitation(encoded, new Date(expiresAt.getTime() - 1000)),
    ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });

    // At the expiry instant: the acceptor fails closed (its `<=` boundary), so a
    // token accepted at or after `expires` is rejected.
    await expect(prepareAcceptedInvitation(encoded, expiresAt)).rejects.toThrow(
      /expired/i,
    );
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
