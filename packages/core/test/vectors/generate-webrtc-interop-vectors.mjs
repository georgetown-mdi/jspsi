// Independent generator for test/vectors/webrtc-interop-vectors.json.
//
// The vectors pin the parts of a CLI<->web WebRTC exchange that BOTH apps
// construct independently from a shared core: the invitation encoding, the
// HKDF-derived rendezvous peer ids, and the per-side pairing of rendezvous role
// to key-exchange handshake role and request-encryption flag. Nothing else
// verifies that a CLI peer and a browser peer agree on those, so each app's own
// construction is driven against this one file from that app's test surface
// (packages/core/test/webrtcInterop.test.ts, apps/cli/test/unit/webrtcInterop.test.ts,
// apps/cli/test/unit/webrtcDispatch.test.ts, apps/web/test/unit/webrtcInterop.test.ts).
//
// Independence: the derivations below are written against Node's OpenSSL-backed
// `node:crypto` (hkdfSync, createHash) while the modules under test run them
// through WebCrypto (crypto.subtle), and the invitation body is serialized here
// from an explicitly ordered literal rather than from the Zod schema whose field
// order it must match. Agreement is therefore a cross-implementation check of
// the construction, not a self-test.
//
// The fixed inputs are boring by design: a shared secret of the bytes
// 0x00..0x1f, a signaling location on an example host, and an invitation whose
// `expires` is far enough out that encodeInvitation's "must be in the future"
// check keeps passing. Nothing here is a credential.
//
// Run:  node packages/core/test/vectors/generate-webrtc-interop-vectors.mjs
// It prints the JSON to stdout; redirect into webrtc-interop-vectors.json to
// refresh, then `npm run format` -- the checked-in file is prettier-formatted,
// which reflows arrays this printer leaves expanded (the sibling generators here
// are the same).

import { createHash, hkdfSync } from "node:crypto";

// --- The shared constructions, restated ---------------------------------------

// rendezvous.ts: HKDF-SHA-256 over the decoded 32-byte secret, 32-byte zero
// salt, info `psilink-webrtc-peerid-v1:<role>`, first 16 bytes, lowercase hex.
const PEER_ID_INFO_PREFIX = "psilink-webrtc-peerid-v1:";
const PEER_ID_BYTES = 16;

// config/invitation.ts: base64url(JSON body) with a 4-byte truncated SHA-256
// checksum appended, also base64url.
const CHECKSUM_BYTES = 4;

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** Mirrors utils/crypto.ts hkdfDerive: HKDF-SHA-256, 32-byte zero salt, named info. */
const hkdfApp = (ikm, info, lengthBytes) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      Buffer.alloc(32),
      Buffer.from(info, "utf8"),
      lengthBytes,
    ),
  );

const derivePeerId = (secretBytes, role) =>
  hex(hkdfApp(secretBytes, `${PEER_ID_INFO_PREFIX}${role}`, PEER_ID_BYTES));

const encodeInvitation = (canonicalJson) => {
  const bytes = Buffer.from(canonicalJson, "utf8");
  const checksum = createHash("sha256").update(bytes).digest();
  return b64url(bytes) + b64url(checksum.subarray(0, CHECKSUM_BYTES));
};

// --- Fixed inputs -------------------------------------------------------------

const SHARED_SECRET_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const secretBytes = Buffer.from(SHARED_SECRET_HEX, "hex");
const sharedSecret = b64url(secretBytes);

// The inviter's browser location, as the web app reads it off `window.location`
// to mint the signaling locator (webrtcEndpointFromLocation in
// apps/web/src/psi/invitation.ts). `port` is a string there, as the DOM gives it.
const signalingLocation = { hostname: "psilink.example.org", port: "8443" };
const signalingPath = "/api/";

const connectionEndpoint = {
  channel: "webrtc",
  host: signalingLocation.hostname,
  port: Number(signalingLocation.port),
  path: signalingPath,
};

// The other mint direction: what `psilink invite` emits from a ws/wss URL, and
// where a BROWSER acceptor seeded from that endpoint opens its signaling socket.
// Stated literally here, as everything in this file is, rather than computed
// from either app's builder.
//
// The path is the reason this direction is pinned at all. Each client resolves
// an endpoint that names no mount point to its OWN default -- `/` in the CLI,
// `/api/` in the browser app -- so a bare-host URL that left the field empty
// would send the two to different sockets and simply never meet. The CLI's mint
// therefore emits the resolved mount point even when the URL wrote none, which
// is what the first vector below fixes.
const cliMintedEndpoints = [
  {
    inviteUrl: `wss://${signalingLocation.hostname}`,
    endpoint: {
      channel: "webrtc",
      host: signalingLocation.hostname,
      path: "/",
    },
    brokerLocation: { host: signalingLocation.hostname, port: 443, path: "/" },
  },
  {
    inviteUrl: `wss://${signalingLocation.hostname}:${signalingLocation.port}/`,
    endpoint: {
      channel: "webrtc",
      host: signalingLocation.hostname,
      port: Number(signalingLocation.port),
      path: "/",
    },
    brokerLocation: {
      host: signalingLocation.hostname,
      port: Number(signalingLocation.port),
      path: "/",
    },
  },
  {
    inviteUrl: `wss://${signalingLocation.hostname}:${signalingLocation.port}/psi`,
    endpoint: {
      channel: "webrtc",
      host: signalingLocation.hostname,
      port: Number(signalingLocation.port),
      path: "/psi",
    },
    brokerLocation: {
      host: signalingLocation.hostname,
      port: Number(signalingLocation.port),
      path: "/psi",
    },
  },
];

// The invitation body in the key order InvitationTokenSchema's parse result
// serializes: top-level version, linkageTerms, sharedSecret, expires,
// connectionEndpoint, disclosedPayloadColumns, and inside a linkage field
// `type` before `name`. Restated here rather than read from the schema, so a
// reordering of either would show up as a vector mismatch instead of being
// followed silently.
const canonicalToken = {
  version: "1",
  linkageTerms: {
    version: "1.0.0",
    identity: "Interop Fixture Party",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ type: "ssn", name: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
  sharedSecret,
  expires: "2999-01-01T00:00:00.000Z",
  connectionEndpoint,
  disclosedPayloadColumns: ["given_name"],
};

const canonicalJson = JSON.stringify(canonicalToken);

// --- Derived ------------------------------------------------------------------

const peerIds = {
  inviter: derivePeerId(secretBytes, "inviter"),
  acceptor: derivePeerId(secretBytes, "acceptor"),
};

/**
 * One rendezvous side's whole pairing. `handshakeRole` and `requestEncryption`
 * are the contract, not a derivation: the acceptor dials the data channel and
 * sends the first key-exchange message (so it is the initiator) while the
 * inviter listens and answers, and neither party asks for the application-layer
 * AEAD over a data channel that DTLS already makes end-to-end confidential.
 */
const sideVector = (side, handshakeRole) => ({
  side,
  localPeerId: peerIds[side],
  remotePeerId: side === "inviter" ? peerIds.acceptor : peerIds.inviter,
  handshakeRole,
  requestEncryption: false,
});

const vectors = {
  description:
    "Known-answer vectors for the parts of a CLI<->web WebRTC exchange that both " +
    "apps construct independently: the invitation encoding, the HKDF-derived " +
    "rendezvous peer ids, and each side's pairing of rendezvous role to " +
    "key-exchange handshake role and request-encryption flag. A divergence in any " +
    "of these passes each app's own tests and fails only when a CLI peer and a " +
    "browser peer first meet, so each app drives its OWN construction against this " +
    "file from its own workspace suite. The key-exchange transcript itself is " +
    "pinned separately by kex-vectors.json, which fixes both ephemeral private " +
    "keys; the handshake as each app invokes it generates its ephemeral key pair " +
    "internally, so what is pinned here is the role and flag each app feeds it.",
  construction: {
    peerId:
      "HKDF-SHA-256 over the decoded 32-byte shared secret, 32-byte zero salt, " +
      `info \`${PEER_ID_INFO_PREFIX}<role>\`, first ${PEER_ID_BYTES} bytes, ` +
      "lowercase hex. Roles are 'inviter' and 'acceptor'; the inviter registers " +
      "with the signaling broker under its own id and the acceptor dials it.",
    invitation:
      "base64url(UTF-8 JSON body) with base64url(SHA-256(body)[0:4]) appended. " +
      "The JSON key order is the invitation schema's parse-result order, which " +
      "canonicalJson below states literally.",
    signaling:
      "The endpoint carries host/port/path only. It names no scheme: each side " +
      "resolves ws vs wss locally (the browser from its own page protocol, the " +
      "CLI from `server.secure`, which defaults to true), so no scheme is pinned " +
      "here. `signaling.endpoint` is the locator a browser inviter mints, and " +
      "`signaling.cliMintedEndpoints` the locators a CLI inviter mints from a " +
      "ws/wss URL, each with the broker location both sides must resolve it to " +
      "-- one entry per mint direction, so neither is left resolving an absent " +
      "field to a default of its own.",
  },
  inputs: {
    sharedSecretHex: SHARED_SECRET_HEX,
    sharedSecret,
    signalingLocation,
  },
  rendezvous: {
    peerIds,
    sides: [
      sideVector("inviter", "responder"),
      sideVector("acceptor", "initiator"),
    ],
  },
  signaling: {
    endpoint: connectionEndpoint,
    // What the CLI's acceptor reaches after seeding a connection from the
    // endpoint above: the broker authority it registers with, and the path the
    // PeerJS signaling socket is opened on.
    brokerHost: `${connectionEndpoint.host}:${connectionEndpoint.port}`,
    brokerPathname: `${signalingPath.replace(/\/$/, "")}/peerjs`,
    cliMintedEndpoints,
  },
  invitation: {
    token: canonicalToken,
    canonicalJson,
    encoded: encodeInvitation(canonicalJson),
  },
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
