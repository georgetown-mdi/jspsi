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
 * The browser companion to apps/web/test/unit/webrtcInterop.test.ts: it runs
 * the same checked-in CLI-to-web interop vectors through the browser build
 * of @psilink/core and the app's accept path in real Chromium, since the
 * rendezvous peer id and invitation checksum are computed on crypto.subtle,
 * a platform-specific implementation this file is the one to check. Which id
 * each flow registers and dials stays the unit suite's subject.
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
