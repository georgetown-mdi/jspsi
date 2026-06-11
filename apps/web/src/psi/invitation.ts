import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import type { InvitationToken, WebRTCEndpoint } from "@psilink/core";

/**
 * Path the self-hosted PeerJS signaling server is mounted at. Kept in sync with
 * `apps/web/src/peerServer.ts` (`CreatePeerServerWSOnly(..., { path: "/api" })`)
 * and the PeerJS client in `psi/client.ts`, which dials the same path.
 */
const PEERJS_SIGNALING_PATH = "/api";

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
}

/**
 * Build the credential-free WebRTC signaling locator the acceptor uses to reach
 * this app's PeerJS server, from the inviter's browser location. Mirrors the
 * PeerJS client (`psi/client.ts`): `localhost` is normalized to a loopback
 * literal a peer can dial, and a default-port location omits the port. The
 * endpoint schema requires a reachable 1-65535 port when present, so a blank or
 * out-of-range port is dropped rather than encoded as a meaningless locator.
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
  const port = loc.port === "" ? Number.NaN : Number.parseInt(loc.port, 10);
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
 * Makes no network request: the encoded invitation is the rendezvous, so the
 * inviter never contacts a session backend (`/api/psi/*`).
 */
export async function generateInvitation(params: {
  inviterName: string;
  location: InvitationLocation;
}): Promise<GeneratedInvitation> {
  const { inviterName, location } = params;

  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms(inviterName),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: webrtcEndpointFromLocation(location),
  };

  const encoded = await encodeInvitation(token);
  return { encoded, deepLink: deepLinkFor(location.origin, encoded) };
}
