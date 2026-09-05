import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  encodeInvitation,
  isInvitationExpired,
} from "../src/config/invitation";
import { RENDEZVOUS_ROLES, deriveRendezvousPeerId } from "../src/rendezvous";

import type { InvitationToken } from "../src/config/invitation";
import type { RendezvousRole } from "../src/rendezvous";

/**
 * The core half of the CLI<->web WebRTC interop conformance check: a CLI
 * peer and a browser peer implement the same rendezvous and authenticated
 * key exchange from this package, independently. This file pins that
 * single implementation against the known-answer vectors in
 * test/vectors/webrtc-interop-vectors.json (produced by an independent
 * node:crypto generator beside it). The parts each app constructs for
 * itself -- peer id, handshake role, request-encryption flag, and token
 * handling -- are driven from each app's own suite against the same file:
 * apps/cli/test/unit/webrtcInterop.test.ts,
 * apps/cli/test/unit/webrtcDispatch.test.ts, and
 * apps/web/test/unit/webrtcInterop.test.ts.
 */

interface InteropVectors {
  inputs: { sharedSecretHex: string; sharedSecret: string };
  rendezvous: {
    peerIds: Record<RendezvousRole, string>;
    sides: Array<{
      side: RendezvousRole;
      localPeerId: string;
      remotePeerId: string;
      handshakeRole: "initiator" | "responder";
      requestEncryption: boolean;
    }>;
  };
  invitation: {
    token: InvitationToken;
    canonicalJson: string;
    encoded: string;
  };
}

const vectors = JSON.parse(
  readFileSync(
    new URL("./vectors/webrtc-interop-vectors.json", import.meta.url),
    {
      encoding: "utf8",
    },
  ),
) as InteropVectors;

describe("rendezvous peer ids", () => {
  test.each(RENDEZVOUS_ROLES)(
    "the %s id reproduces the known-answer vector",
    async (role) => {
      expect(
        await deriveRendezvousPeerId(vectors.inputs.sharedSecret, role),
      ).toBe(vectors.rendezvous.peerIds[role]);
    },
  );

  test("the vector covers every rendezvous role core defines", () => {
    // A role added to core without a vector leaves one side of a rendezvous
    // unpinned, which is exactly the divergence this file exists to catch.
    expect(Object.keys(vectors.rendezvous.peerIds).sort()).toEqual(
      [...RENDEZVOUS_ROLES].sort(),
    );
    expect(vectors.rendezvous.sides.map((s) => s.side).sort()).toEqual(
      [...RENDEZVOUS_ROLES].sort(),
    );
  });

  test("each side dials the other's id, and the two ids differ", () => {
    for (const side of vectors.rendezvous.sides) {
      expect(side.localPeerId).toBe(vectors.rendezvous.peerIds[side.side]);
      const other = RENDEZVOUS_ROLES.find((role) => role !== side.side);
      expect(side.remotePeerId).toBe(
        vectors.rendezvous.peerIds[other as RendezvousRole],
      );
    }
    expect(vectors.rendezvous.peerIds.inviter).not.toBe(
      vectors.rendezvous.peerIds.acceptor,
    );
  });

  test("the derived id is the hex shape the PeerJS id grammar accepts", () => {
    for (const id of Object.values(vectors.rendezvous.peerIds))
      expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the two sides take complementary key-exchange roles", () => {
  test("one initiator, one responder, and neither asks for the AEAD wrap", () => {
    // The pairing itself, held here so both apps assert the same table rather
    // than each app's own reading of it. Neither party requests the
    // application-layer AEAD: a data channel is already end-to-end confidential
    // under DTLS, and the browser peer refuses a partner that asks.
    expect(
      vectors.rendezvous.sides.map((s) => [s.side, s.handshakeRole]),
    ).toEqual([
      ["inviter", "responder"],
      ["acceptor", "initiator"],
    ]);
    expect(vectors.rendezvous.sides.every((s) => !s.requestEncryption)).toBe(
      true,
    );
  });
});

describe("invitation encoding", () => {
  test("encoding the vector token reproduces the pinned string", async () => {
    expect(await encodeInvitation(vectors.invitation.token)).toBe(
      vectors.invitation.encoded,
    );
  });

  test("the encoded body is the pinned canonical JSON", () => {
    // The key order, field names, and base64url alphabet a foreign decoder has
    // to read, separated from the checksum so a mismatch names which half moved.
    const body = vectors.invitation.encoded.slice(0, -6);
    expect(Buffer.from(body, "base64url").toString("utf8")).toBe(
      vectors.invitation.canonicalJson,
    );
  });

  test("decoding the pinned string yields the vector token", async () => {
    expect(await decodeInvitation(vectors.invitation.encoded)).toEqual(
      vectors.invitation.token,
    );
  });

  test("the token carries the secret the peer ids are derived from", () => {
    // Ties the two halves of the fixture together: an app that decodes this
    // token and derives a rendezvous id from what it holds lands on the ids
    // pinned above.
    expect(vectors.invitation.token.sharedSecret).toBe(
      vectors.inputs.sharedSecret,
    );
    expect(Buffer.from(vectors.inputs.sharedSecretHex, "hex")).toEqual(
      Buffer.from(vectors.inputs.sharedSecret, "base64url"),
    );
  });

  test("the vector token is not expired, so both apps' accept gates admit it", () => {
    expect(isInvitationExpired(vectors.invitation.token.expires)).toBe(false);
  });
});
