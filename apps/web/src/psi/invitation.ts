import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import type { InvitationToken, WebRTCEndpoint } from "@psilink/core";

/**
 * Path a PeerJS client dials this app's signaling server at. Matches the dial
 * path used in `psi/rendezvous.ts` (`path: "/api/"`), which the server -- mounted
 * at `/api` by `apps/web/src/peerServer.ts` -- accepts. The acceptor reads this off
 * the endpoint and dials it the same way a client does, so it must carry the
 * client's dial path (trailing slash included), not the server's mount path.
 */
const PEERJS_SIGNALING_PATH = "/api/";

/**
 * Default invitation lifetime: one hour, the bound a web invitation takes when no
 * lifetime is selected. Matches the CLI's default (`INVITATION_LIFETIME_SECONDS`
 * in apps/cli/src/commands/invite.ts) and the "default expiration window of 1
 * hour" docs/SECURITY_DESIGN.md states, so both inviters agree on the same bound
 * and that claim holds for web-generated invitations. Held as a local constant
 * rather than shared from core for the same reason the CLI keeps its own copy:
 * the value is a policy default, not a cryptographic helper, and core's
 * invitation module is a consumer here, not where web policy belongs.
 */
export const INVITATION_LIFETIME_SECONDS = 60 * 60;

/**
 * Route the deep-link targets: the acceptor's accept/reject consent screen. The
 * route itself -- decode, linkage-terms review, and the derived-id rendezvous --
 * is built by the web rendezvous task (item 196035727); this module only
 * constructs a URL that points at it. The token rides in the URL fragment (see
 * {@link deepLinkFor}), so the contract this constant encodes is "path plus
 * fragment", which 196035727 must read in lockstep.
 */
export const ACCEPT_ROUTE_PATH = "/accept";

/**
 * The browser-location inputs an invitation needs: the deep-link origin and the
 * host/port the acceptor reaches the PeerJS signaling server at. Passed in rather
 * than read from `window` inside assembly so {@link generateInvitation} stays
 * pure and unit-testable; the caller supplies `window.location` values.
 */
export interface InvitationLocation {
  /** Deep-link origin, e.g. `https://example.org:3000` (no trailing slash). */
  origin: string;
  /** Hostname for the signaling endpoint, as `window.location.hostname`. */
  hostname: string;
  /** Port as `window.location.port` gives it: a string, `""` for the protocol default. */
  port: string;
}

/** A generated invitation in the two forms the inviter shares; both carry the
 * same encoded token, so they decode identically. */
export interface GeneratedInvitation {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /**
   * Deep-link URL `<origin>/accept#<encoded>` -- the URL copy artifact. The
   * token rides in the fragment, never a query parameter, so this confidential
   * value (it carries the setup secret and seeds the rendezvous id) is not sent
   * to the server and stays out of access logs and Referer headers; see
   * docs/SECURITY_DESIGN.md, "Invitation contents and confidentiality".
   */
  deepLink: string;
  /**
   * The fresh shared secret embedded in the token. Returned so the inviter can
   * derive its own rendezvous peer id and listen on it (the acceptor derives the
   * same id from the same secret carried in the invitation). It is the value
   * already inside `encoded`, surfaced here rather than re-decoded; it stays in
   * the browser and is never sent to a backend.
   */
  sharedSecret: string;
}

/**
 * Build the credential-free WebRTC signaling locator the acceptor uses to reach
 * this app's PeerJS server, from the inviter's browser location. Mirrors the
 * acceptor's dial-location handling (`psi/rendezvous.ts`): `localhost` is
 * normalized to a loopback literal a peer can dial, and a default-port location
 * omits the port. The endpoint schema requires a reachable 1-65535 port when
 * present, so a blank or out-of-range port is dropped rather than encoded as a
 * meaningless locator.
 */
export function webrtcEndpointFromLocation(loc: {
  hostname: string;
  port: string;
}): WebRTCEndpoint {
  const host = loc.hostname === "localhost" ? "127.0.0.1" : loc.hostname;
  const endpoint: WebRTCEndpoint = {
    channel: "webrtc",
    host,
    path: PEERJS_SIGNALING_PATH,
  };
  // Number() rather than parseInt: a non-numeric port like "8080abc" becomes NaN
  // and is dropped instead of being truncated to 8080, and an empty default-port
  // location becomes 0, which the `>= 1` guard rejects -- so the port is omitted.
  const port = Number(loc.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535)
    endpoint.port = port;
  return endpoint;
}

/** Build the deep-link URL carrying `encoded` in the fragment (see
 * {@link GeneratedInvitation.deepLink} for why the fragment, not a query). */
export function deepLinkFor(origin: string, encoded: string): string {
  return `${origin}${ACCEPT_ROUTE_PATH}#${encoded}`;
}

/**
 * Generate a fresh single-use invitation: a new shared secret, the inviter's
 * linkage terms, and this app's PeerJS endpoint, encoded to a string and also
 * wrapped as a deep-link URL. Each call mints a new secret, so calling it again
 * supersedes any prior unsent invitation -- a fresh secret means a fresh derived
 * rendezvous id, and there is no expectation that one invitation supports more
 * than one exchange.
 *
 * `linkageTerms` come from {@link getDefaultLinkageTerms} keyed on the inviter's
 * name: the web app authors no explicit fields or keys (deferred to the
 * configuration-GUI roadmap item), so the defaults plus the inviter identity are
 * the real terms the acceptor reviews -- never empty or placeholder.
 *
 * The token carries a bounded `expires` (default {@link INVITATION_LIFETIME_SECONDS},
 * one hour) so an intercepted invitation has a finite misuse window. The acceptor
 * enforces it (`prepareAcceptedInvitation` rejects a token whose `expires` is at
 * or before the accept instant), and both sides read the same ISO-8601 `expires`,
 * so the bound the inviter sets is the bound the acceptor honors.
 *
 * Makes no network request: the encoded invitation is the rendezvous, so the
 * inviter never contacts a session backend (`/api/psi/*`).
 */
export async function generateInvitation(params: {
  inviterName: string;
  location: InvitationLocation;
  /**
   * Invitation lifetime in seconds; defaults to {@link INVITATION_LIFETIME_SECONDS}
   * (one hour). The web app has no lifetime-selection UI yet, so production
   * callers omit it and take the default; the parameter is the seam a future
   * selector (the configuration-GUI roadmap item) overrides through without
   * reshaping this entry point.
   */
  lifetimeSeconds?: number;
  /**
   * The instant the lifetime is measured from; the minted `expires` is
   * `now + lifetimeSeconds`. Injectable for deterministic tests (mirroring
   * `prepareAcceptedInvitation`'s `now`), defaulting to the current time.
   */
  now?: Date;
}): Promise<GeneratedInvitation> {
  const {
    inviterName,
    location,
    lifetimeSeconds = INVITATION_LIFETIME_SECONDS,
    now = new Date(),
  } = params;

  // Bound the token's lifetime so an intercepted invitation cannot be accepted
  // indefinitely. The CLI mints `expires` the same way (expiresFromNow in
  // apps/cli/src/commands/bootstrap.ts); encodeInvitation rejects a non-future
  // `expires` as a backstop, so a non-positive lifetime is caught at encode.
  const expires = new Date(
    now.getTime() + lifetimeSeconds * 1000,
  ).toISOString();
  const sharedSecret = generateSharedSecret();
  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms(inviterName),
    sharedSecret,
    expires,
    connectionEndpoint: webrtcEndpointFromLocation(location),
  };

  const encoded = await encodeInvitation(token);
  return {
    encoded,
    deepLink: deepLinkFor(location.origin, encoded),
    sharedSecret,
  };
}
