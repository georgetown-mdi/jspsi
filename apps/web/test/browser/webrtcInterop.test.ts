/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import {
  RENDEZVOUS_ROLES,
  deriveRendezvousPeerId,
  encodeInvitation,
} from "@psilink/core";

import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import vectorsRaw from "../../../../packages/core/test/vectors/webrtc-interop-vectors.json?raw";

import type {
  InvitationToken,
  RendezvousRole,
  WebRTCEndpoint,
} from "@psilink/core";

/**
 * The browser companion to apps/web/test/unit/webrtcInterop.test.ts: the
 * checked-in CLI-to-web interop vectors, run through the browser build of
 * @psilink/core and of the app's accept path in real Chromium.
 *
 * The rendezvous peer id and the invitation's checksum are both computed on
 * crypto.subtle, a different implementation on each platform (Node's OpenSSL,
 * Chromium's BoringSSL), and Chromium is where the CLI's partner actually runs.
 * A Node-only assertion of these therefore leaves the platform half of the
 * contract unmeasured -- the same reason the key-exchange vectors are asserted
 * from both platforms (test/browser/kex.test.ts) rather than one. The vectors
 * are read the way that suite reads its own, through Vite's `?raw`.
 *
 * The app's own rendezvous module cannot be imported in the browser runner (its
 * top-level config load reads `process`; see test/browser/moduleMocks.ts), so
 * which id each flow registers and dials stays the unit suite's subject. What
 * is platform-dependent is the derivation itself, and that is here.
 */

interface InteropVectors {
  inputs: { sharedSecret: string };
  rendezvous: { peerIds: Record<RendezvousRole, string> };
  signaling: { endpoint: WebRTCEndpoint };
  invitation: { token: InvitationToken; encoded: string };
}

const vectors = JSON.parse(vectorsRaw) as InteropVectors;

const { sharedSecret } = vectors.inputs;

describe("the rendezvous ids the browser derives", () => {
  test.each(RENDEZVOUS_ROLES)(
    "Chromium reproduces the %s id vector",
    async (role) => {
      expect(await deriveRendezvousPeerId(sharedSecret, role)).toBe(
        vectors.rendezvous.peerIds[role],
      );
    },
  );

  test("the two derived ids differ, so the sides meet rather than collide", () => {
    expect(vectors.rendezvous.peerIds.inviter).not.toBe(
      vectors.rendezvous.peerIds.acceptor,
    );
  });
});

describe("the invitation the browser mints and consumes", () => {
  test("encoding the vector token reproduces the pinned string", async () => {
    // The trailing checksum is SHA-256 over the body, computed here on the
    // browser's own implementation and read by the CLI's decoder.
    expect(await encodeInvitation(vectors.invitation.token)).toBe(
      vectors.invitation.encoded,
    );
  });

  test("the accept path decodes the pinned string to the vector token", async () => {
    const accepted = await prepareAcceptedInvitation(
      vectors.invitation.encoded,
      { profile: "hosted" },
    );
    expect(accepted.token).toEqual(vectors.invitation.token);
    expect(accepted.endpoint).toEqual(vectors.signaling.endpoint);
  });

  test.each(RENDEZVOUS_ROLES)(
    "the decoded secret derives the vector's %s id in the browser",
    async (role) => {
      // The two halves tied together on this platform: an id derived from what
      // the browser's own decode yielded is the id the vectors pin.
      const accepted = await prepareAcceptedInvitation(
        vectors.invitation.encoded,
        { profile: "hosted" },
      );
      expect(
        await deriveRendezvousPeerId(accepted.token.sharedSecret, role),
      ).toBe(vectors.rendezvous.peerIds[role]);
    },
  );
});
