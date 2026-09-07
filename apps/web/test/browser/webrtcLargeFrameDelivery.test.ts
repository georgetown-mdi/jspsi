/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test } from "vitest";

import { pack } from "peerjs-js-binarypack";

import { encodeBinaryPackValue, generateSharedSecret } from "@psilink/core";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection.js";

import { canReachServer } from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";

import type { Packable } from "peerjs-js-binarypack";

/**
 * The web transport's outbound encoder against the real stack: a real PeerJS
 * pair over the app's own broker, in real Chromium, sending the largest of the
 * four record-scaling frames at a size PeerJS's own packer cannot encode at all.
 * Only the real stack can say the replaced `_send` still chunks, buffers and
 * delivers as PeerJS does.
 */

const addressInfo = {
  address: "127.0.0.1",
  port: inject("webDevServerPort") ?? 3000,
};
const hostString = `http://${addressInfo.address}:${String(addressInfo.port)}`;
const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

/** One entry per matched record, the shape the PSI round's iteration map takes
 * (packages/core/src/psi/link.ts). */
function iterationMap(
  records: number,
): Array<{ theirIndex: number; iteration: number }> {
  return Array.from({ length: records }, (_, index) => ({
    theirIndex: index,
    iteration: index % 3,
  }));
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

test("a 200,000-record frame reaches the peer whole", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);

  const frame = iterationMap(200_000);
  // The reason this test exists: PeerJS packs with a recursive packer that
  // cannot encode this frame at all, so before the replacement the exchange
  // died here -- on the sender, after both parties had paid for the PSI compute.
  expect(() => pack(frame as Packable)).toThrow();
  const sentDigest = await digest(new Uint8Array(encodeBinaryPackValue(frame)));

  const pair = await connectRendezvousPair(generateSharedSecret(), addressInfo);
  try {
    const senderMc = await openPeerMessageConnection(pair.acceptorConn);
    const receiverMc = await openPeerMessageConnection(pair.inviterConn);

    await senderMc.send(frame);
    const received = await receiverMc.receive(60_000);

    // Compared by digest of the re-encoded frame rather than element by element:
    // the bytes are the contract, and 200,000 objects compared structurally cost
    // more than the exchange itself.
    expect(await digest(new Uint8Array(encodeBinaryPackValue(received)))).toBe(
      sentDigest,
    );

    await senderMc.close();
    await receiverMc.close();
  } finally {
    pair.inviterPeer.destroy();
    pair.acceptorPeer.destroy();
  }
}, 180_000);
