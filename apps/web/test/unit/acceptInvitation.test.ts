import { describe, expect, test } from "vitest";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { prepareAcceptedInvitation } from "../../src/psi/acceptInvitation.js";

import type { ConnectionEndpoint, InvitationToken } from "@psilink/core";

const webrtcEndpoint: ConnectionEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

async function encode(
  overrides: Partial<InvitationToken> = {},
): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter"),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: webrtcEndpoint,
    ...overrides,
  };
  return encodeInvitation(token);
}

describe("prepareAcceptedInvitation", () => {
  test("accepts a valid, unexpired invitation with a WebRTC endpoint", async () => {
    const secret = generateSharedSecret();
    const encoded = await encode({ sharedSecret: secret });

    const { token, endpoint } = await prepareAcceptedInvitation(encoded);

    expect(token.sharedSecret).toBe(secret);
    expect(endpoint.channel).toBe("webrtc");
    expect(endpoint.host).toBe("127.0.0.1");
  });

  test("rejects an expired invitation (before any connect)", async () => {
    // encodeInvitation refuses a past `expires`, so encode with a future expiry
    // and evaluate acceptance at an instant after it -- the same fail-closed
    // check the accept page runs before rendering the connecting UI.
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, new Date("2030-01-01T00:00:01.000Z")),
    ).rejects.toThrow(/expired/i);
  });

  test("accepts an invitation that has not yet expired", async () => {
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, new Date("2029-12-31T23:59:59.000Z")),
    ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });
  });

  test("rejects an invitation with no connection endpoint", async () => {
    const encoded = await encode({ connectionEndpoint: undefined });

    await expect(prepareAcceptedInvitation(encoded)).rejects.toThrow(/WebRTC/i);
  });

  test("rejects an invitation whose endpoint is not WebRTC", async () => {
    const encoded = await encode({
      connectionEndpoint: {
        channel: "sftp",
        host: "sftp.example.com",
        port: 22,
      },
    });

    await expect(prepareAcceptedInvitation(encoded)).rejects.toThrow(/WebRTC/i);
  });

  test("rejects a malformed invitation string", async () => {
    await expect(
      prepareAcceptedInvitation("not-a-real-invitation"),
    ).rejects.toThrow();
  });
});
