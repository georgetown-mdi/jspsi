import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_MESSAGES_PER_QUEUE,
  MAX_OUTSTANDING_QUEUES,
  MAX_QUEUE_BYTES,
  Realm,
} from "@psilink/peerjs-broker/models/realm";
import { CheckBrokenConnections } from "@psilink/peerjs-broker/services/checkBrokenConnections/index";
import { Client } from "@psilink/peerjs-broker/models/client";
import { MAX_SIGNALING_PAYLOAD_BYTES } from "@psilink/peerjs-broker/services/webSocketServer/index";
import { MessageType } from "@psilink/peerjs-broker/enums";
import { PEER_PING_INTERVAL_MS } from "@psi/transport/rendezvous";
import defaultConfig from "@psilink/peerjs-broker/config/index";
import { deriveRendezvousPeerId } from "@psilink/core";
import { serializeFrame } from "@psilink/peerjs-broker/models/messageQueue";

import type { IMessage } from "@psilink/peerjs-broker/models/message";

/** The resident bytes a frame is accounted at, which is what the queue holds
 * it as: the frame serialized. */
function accountedBytes(message: IMessage): number {
  return serializeFrame(message).byteSize;
}

// Unit coverage for the two gap-2 controls that need no socket: the two-tier
// liveness reaper (a registered-but-never-heartbeated client is cleared well
// before the generous alive_timeout, while a client that has shown liveness keeps
// the full window), and the relay's per-destination queue bounds (a spray to many
// unregistered destinations cannot allocate queues without limit).

// Source the reap windows from the production defaults (90_000 / 20_000) rather
// than mirroring the literals, so the behavioral tests below exercise the same
// values the `liveness-timeout config invariant` block pins -- a future edit to
// the defaults cannot leave a behavioral test passing against a stale local copy.
const ALIVE_TIMEOUT_MS = defaultConfig.alive_timeout;
const UNCONFIRMED_TIMEOUT_MS = defaultConfig.unconfirmed_timeout;
const CHECK_INTERVAL_MS = 100;

describe("two-tier liveness reaper", () => {
  // Fake timers drive both the reaper's setTimeout loop and the `new Date()`
  // clock its threshold compares against, so the windows are exercised
  // deterministically rather than by real waits.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function startReaper(realm: Realm): CheckBrokenConnections {
    const reaper = new CheckBrokenConnections({
      realm,
      config: {
        alive_timeout: ALIVE_TIMEOUT_MS,
        unconfirmed_timeout: UNCONFIRMED_TIMEOUT_MS,
      },
      checkInterval: CHECK_INTERVAL_MS,
    });
    reaper.start();
    return reaper;
  }

  test("reaps a client that never sends a frame at the unconfirmed window", () => {
    const realm = new Realm();
    realm.setClient(new Client({ id: "junk", token: "t" }), "junk");
    const reaper = startReaper(realm);
    try {
      // Just inside the unconfirmed window: still registered.
      vi.advanceTimersByTime(UNCONFIRMED_TIMEOUT_MS - 1_000);
      expect(realm.getClientById("junk")).toBeDefined();
      // Past it: reaped, far short of alive_timeout.
      vi.advanceTimersByTime(2_000);
      expect(realm.getClientById("junk")).toBeUndefined();
    } finally {
      reaper.stop();
    }
  });

  test("a client that has shown liveness survives past the unconfirmed window", () => {
    const realm = new Realm();
    const client = new Client({ id: "live", token: "t" });
    client.confirm();
    realm.setClient(client, "live");
    const reaper = startReaper(realm);
    try {
      // Well past the unconfirmed window but within alive_timeout: kept, because
      // the reap is tied to liveness rather than a flat wall-clock.
      vi.advanceTimersByTime(60_000);
      expect(realm.getClientById("live")).toBeDefined();
    } finally {
      reaper.stop();
    }
  });

  test("a peer that confirms at the heartbeat cadence graduates past the unconfirmed window", () => {
    // Distinct from the pre-confirmed "shown liveness survives" case above: this
    // exercises the unconfirmed -> confirmed transition timed at the real client
    // cadence -- a peer that registers silent and only proves liveness when its
    // first heartbeat lands. That is the slow-but-live invited peer the
    // unconfirmed window must not cut.
    const realm = new Realm();
    const client = new Client({ id: "slow", token: "t" });
    realm.setClient(client, "slow");
    const reaper = startReaper(realm);
    try {
      // The PeerJS client's first heartbeat lands at the pinned cadence, which is
      // comfortably inside the unconfirmed window (pinned at >= 4x the cadence by
      // the invariant test below), so the peer is still registered -- not yet
      // reaped -- when that frame arrives.
      vi.advanceTimersByTime(PEER_PING_INTERVAL_MS);
      expect(realm.getClientById("slow")).toBeDefined();

      // That first inbound frame confirms the peer, graduating it from the
      // unconfirmed window to the generous alive window. Advance past the
      // unconfirmed deadline it would have been reaped at had it stayed silent: it
      // survives, because the reap is tied to liveness, not a flat wall-clock.
      client.confirm();
      vi.advanceTimersByTime(UNCONFIRMED_TIMEOUT_MS);
      expect(realm.getClientById("slow")).toBeDefined();
    } finally {
      reaper.stop();
    }
  });

  test("a confirmed client that then goes silent is reaped at alive_timeout", () => {
    const realm = new Realm();
    const client = new Client({ id: "stale", token: "t" });
    client.confirm();
    realm.setClient(client, "stale");
    const reaper = startReaper(realm);
    try {
      vi.advanceTimersByTime(ALIVE_TIMEOUT_MS + 1_000);
      expect(realm.getClientById("stale")).toBeUndefined();
    } finally {
      reaper.stop();
    }
  });

  test("a liveness-reset (reconnected) client returns to the unconfirmed window", () => {
    const realm = new Realm();
    const client = new Client({ id: "recon", token: "t" });
    client.confirm();
    realm.setClient(client, "recon");
    const reaper = startReaper(realm);
    try {
      // Confirmed: survives well past the unconfirmed window.
      vi.advanceTimersByTime(30_000);
      expect(realm.getClientById("recon")).toBeDefined();

      // Reconnect attaches a new socket and resets liveness.
      client.resetLiveness();
      expect(client.isConfirmed()).toBe(false);

      // The reset refreshes lastPing, so the client is NOT instantly reaped
      // against the 30s-stale prior timestamp -- it gets a fresh unconfirmed
      // window from the reset.
      vi.advanceTimersByTime(10_000);
      expect(realm.getClientById("recon")).toBeDefined();

      // Silent past the unconfirmed window since the reset: reaped.
      vi.advanceTimersByTime(15_000);
      expect(realm.getClientById("recon")).toBeUndefined();
    } finally {
      reaper.stop();
    }
  });
});

describe("relay message-queue bounds", () => {
  function offerTo(dst: string): IMessage {
    return { type: MessageType.OFFER, src: "spammer", dst };
  }

  // A near-full-size signaling frame: a 64 K-character payload, so MAX_QUEUE_BYTES
  // is reached in a handful of frames -- the byte cap binds well before the
  // 100-message count cap, which is the point of the byte dimension.
  const FRAME_PAYLOAD_CHARS = 64 * 1024;
  function bigOfferTo(dst: string): IMessage {
    return {
      type: MessageType.OFFER,
      src: "spammer",
      dst,
      payload: "x".repeat(FRAME_PAYLOAD_CHARS),
    };
  }

  // A structured payload just under the wire cap, of the property-dense nested
  // shape whose parsed form outweighs its serialized bytes by the widest margin
  // -- the shape the queue must not hold in parsed form.
  const NEAR_WIRE_CAP_CHARS = MAX_SIGNALING_PAYLOAD_BYTES - 1024;
  function densePayload(targetChars: number): unknown {
    const rows: Array<Record<string, unknown>> = [];
    let chars = 2;
    for (let k = 0; chars < targetChars; k += 1) {
      const row = { k, a: [1, 2, 3], b: { c: "x", d: true } };
      chars += JSON.stringify(row).length + (rows.length > 0 ? 1 : 0);
      rows.push(row);
    }
    return rows;
  }

  test("caps the number of distinct queued destinations", () => {
    const realm = new Realm();
    // Spray more distinct unregistered destinations than the bound allows.
    for (let i = 0; i < MAX_OUTSTANDING_QUEUES + 500; i += 1) {
      realm.addMessageToQueue(`dst-${i}`, offerTo(`dst-${i}`));
    }
    expect(realm.getClientsIdsWithQueue().length).toBe(MAX_OUTSTANDING_QUEUES);
  });

  test("caps the depth of a single queue", () => {
    const realm = new Realm();
    for (let i = 0; i < MAX_MESSAGES_PER_QUEUE + 50; i += 1) {
      realm.addMessageToQueue("dst", offerTo("dst"));
    }
    expect(realm.getMessageQueueById("dst")?.size()).toBe(
      MAX_MESSAGES_PER_QUEUE,
    );
  });

  test("caps the resident bytes of a single queue", () => {
    const realm = new Realm();
    // Spray far more full-size frames than the byte cap can hold. The count cap
    // (100) is never reached, so it is the byte cap that bounds the queue.
    for (let i = 0; i < 200; i += 1) {
      realm.addMessageToQueue("dst", bigOfferTo("dst"));
    }
    const queue = realm.getMessageQueueById("dst");
    expect(queue).toBeDefined();
    expect(queue!.byteSize()).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(queue!.size()).toBeLessThan(MAX_MESSAGES_PER_QUEUE);
    // The queue actually filled to within one frame of the cap -- the bound is
    // doing real work, not rejecting at zero.
    expect(queue!.byteSize()).toBeGreaterThan(
      MAX_QUEUE_BYTES - accountedBytes(bigOfferTo("dst")),
    );
  });

  test("counts resident (UTF-16) bytes, so a non-Latin1 payload cannot evade the cap", () => {
    // V8 stores a string as two bytes per character once it holds any non-Latin1
    // character, so an all-`Ā` payload and an equal-length ASCII payload
    // have the same heap residency. The accounting must size them identically;
    // a UTF-8 measure would call the ASCII one half the size and let a wide
    // payload occupy ~2x the cap while measuring under it. Both are sized at
    // the form the queue holds, which for a payload that arrived as a string is
    // that string itself.
    const base = { type: MessageType.OFFER, src: "s", dst: "d" } as const;
    const ascii: IMessage = {
      ...base,
      payload: "a".repeat(FRAME_PAYLOAD_CHARS),
    };
    const wide: IMessage = {
      ...base,
      payload: "Ā".repeat(FRAME_PAYLOAD_CHARS),
    };
    expect(accountedBytes(ascii)).toBe(accountedBytes(wide));
    expect(accountedBytes(wide)).toBe(
      2 * ("OFFER".length + "s".length + "d".length + FRAME_PAYLOAD_CHARS),
    );

    // And the queue enforces the cap against a wide-payload spray just the same.
    const realm = new Realm();
    const wideOfferTo = (dst: string): IMessage => ({
      type: MessageType.OFFER,
      src: "spammer",
      dst,
      payload: "Ā".repeat(FRAME_PAYLOAD_CHARS),
    });
    for (let i = 0; i < 200; i += 1) {
      realm.addMessageToQueue("dst", wideOfferTo("dst"));
    }
    expect(realm.getMessageQueueById("dst")!.byteSize()).toBeLessThanOrEqual(
      MAX_QUEUE_BYTES,
    );
  });

  test("sizes a structured payload by its serialized bytes and queues it", () => {
    // payload is typed string, but every real signaling payload -- an SDP offer
    // or answer, an ICE candidate -- reaches the relay as a parsed JSON object.
    // Such a frame must be held for an absent peer, sized by what crossed the
    // wire, rather than rejected by the byte accounting.
    const payload = {
      sdp: { type: "offer", sdp: "v=0\r\na=group:BUNDLE 0\r\n" },
      type: "data",
      connectionId: "dc_9c1f",
    };
    const offer = {
      type: MessageType.OFFER,
      src: "s",
      dst: "d",
      payload,
    } as unknown as IMessage;

    expect(accountedBytes(offer)).toBe(
      2 * ("OFFER".length + "s".length + "d".length) +
        2 * JSON.stringify(payload).length,
    );

    const realm = new Realm();
    realm.addMessageToQueue("d", offer);
    const queue = realm.getMessageQueueById("d");
    expect(queue?.size()).toBe(1);
    expect(queue?.byteSize()).toBe(accountedBytes(offer));
    expect(queue?.readMessage()?.payload).toEqual(payload);
  });

  test("holds a property-dense payload as the string it was accounted at", () => {
    // The queue must retain the serialization it counted, not the parsed object
    // it arrived as: a parsed object of this shape occupies a large multiple of
    // its serialized bytes, so holding it would leave MAX_QUEUE_BYTES bounding
    // something other than the memory the process holds. Sized at the
    // wire cap, where that divergence is worth the most to an attacker.
    const payload = densePayload(NEAR_WIRE_CAP_CHARS);
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeGreaterThan(
      MAX_SIGNALING_PAYLOAD_BYTES - 2048,
    );
    expect(serialized.length).toBeLessThanOrEqual(MAX_SIGNALING_PAYLOAD_BYTES);
    const offer = {
      type: MessageType.OFFER,
      src: "s",
      dst: "d",
      payload,
    } as unknown as IMessage;

    const realm = new Realm();
    realm.addMessageToQueue("d", offer);
    const queue = realm.getMessageQueueById("d")!;

    const [held] = queue.getMessages();
    expect(held.message.payload).toBe(serialized);
    // What is held is what was counted -- exactly, field by field, with no
    // parsed form of the payload left on the queue and no unaccounted field
    // riding along.
    expect(Object.keys(held.message).sort()).toEqual([
      "dst",
      "payload",
      "src",
      "type",
    ]);
    expect(held.byteSize).toBe(
      2 * ("OFFER".length + "s".length + "d".length) +
        Buffer.byteLength(serialized, "utf16le"),
    );
    expect(queue.byteSize()).toBe(held.byteSize);

    // The parsed form is reconstituted for delivery, so the peer that drains
    // the queue still receives the payload it was sent.
    expect(queue.readMessage()?.payload).toEqual(payload);
    expect(queue.byteSize()).toBe(0);
  });

  test("refuses a structured payload past the cap at the same threshold as an equal string payload", () => {
    // A dense object and a string that serialize to the same length are held at
    // the same residency, so the byte cap admits and refuses them identically:
    // arriving as an object buys no extra room in the queue.
    const payload = densePayload(NEAR_WIRE_CAP_CHARS);
    const serialized = JSON.stringify(payload);
    // A payload that arrives as a string is held as it arrived, so a string of
    // the object's serialized length occupies exactly the object's residency.
    const equivalentString = "x".repeat(serialized.length);

    const fill = (payloadValue: unknown): Realm => {
      const realm = new Realm();
      for (let i = 0; i < 3; i += 1) {
        realm.addMessageToQueue("dst", {
          type: MessageType.OFFER,
          src: "spammer",
          dst: "dst",
          payload: payloadValue,
        } as unknown as IMessage);
      }
      return realm;
    };

    const objectQueue = fill(payload).getMessageQueueById("dst")!;
    const stringQueue = fill(equivalentString).getMessageQueueById("dst")!;

    expect(objectQueue.byteSize()).toBe(stringQueue.byteSize());
    expect(objectQueue.size()).toBe(stringQueue.size());
    expect(objectQueue.byteSize()).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    // A near-wire-cap frame is still holdable, and the cap refuses the frames
    // behind it rather than the count cap doing the work.
    expect(objectQueue.size()).toBe(1);
  });

  test("caps the resident bytes of a queue sprayed with structured payloads", () => {
    // The byte cap binds on the serialized size just as it does on a string
    // payload: a structured payload cannot evade it by arriving as an object.
    const realm = new Realm();
    const bigObjectOfferTo = (dst: string): IMessage =>
      ({
        type: MessageType.OFFER,
        src: "spammer",
        dst,
        payload: { sdp: "x".repeat(FRAME_PAYLOAD_CHARS) },
      }) as unknown as IMessage;
    for (let i = 0; i < 200; i += 1) {
      realm.addMessageToQueue("dst", bigObjectOfferTo("dst"));
    }
    const queue = realm.getMessageQueueById("dst")!;
    expect(queue.byteSize()).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(queue.byteSize()).toBeGreaterThan(
      MAX_QUEUE_BYTES - accountedBytes(bigObjectOfferTo("dst")),
    );
  });

  test("holds the largest wire-legal frame addressed between rendezvous ids", async () => {
    // MAX_QUEUE_BYTES is twice the wire cap so that any single legal frame can
    // always be held, but at the extreme that headroom is two bytes wide: a
    // frame charged for a byte that never crossed the wire spends it and is
    // refused. The worst case is the biggest frame a peer can actually put on
    // the socket -- the sender omits `src`, which the server stamps for it, so
    // every byte saved there becomes payload -- addressed between the two ids
    // psilink derives for a rendezvous.
    const secret = Buffer.alloc(32, 1).toString("base64url");
    const inviterId = await deriveRendezvousPeerId(secret, "inviter");
    const acceptorId = await deriveRendezvousPeerId(secret, "acceptor");

    const envelopeChars = JSON.stringify({
      type: MessageType.OFFER,
      dst: inviterId,
      payload: "",
    }).length;
    const payload = "x".repeat(MAX_SIGNALING_PAYLOAD_BYTES - envelopeChars);
    // Wire-legal to the byte: one more payload character and `ws` refuses the
    // frame at `maxPayload` before the relay ever sees it.
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: MessageType.OFFER,
          dst: inviterId,
          payload,
        }),
        "utf8",
      ),
    ).toBe(MAX_SIGNALING_PAYLOAD_BYTES);

    const realm = new Realm();
    realm.addMessageToQueue(inviterId, {
      type: MessageType.OFFER,
      src: acceptorId,
      dst: inviterId,
      payload,
    });
    const queue = realm.getMessageQueueById(inviterId);
    expect(queue?.size()).toBe(1);

    // Held as it arrived, and accounted at exactly the strings held -- nothing
    // added on the way in, so the accounting stays under the cap.
    const [held] = queue!.getMessages();
    expect(held.message.payload).toBe(payload);
    expect(held.byteSize).toBe(
      2 *
        (MessageType.OFFER.length +
          acceptorId.length +
          inviterId.length +
          payload.length),
    );
    expect(held.byteSize).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(queue!.byteSize()).toBe(held.byteSize);
    expect(queue!.readMessage()?.payload).toBe(payload);
  });

  test("drops a frame's extra top-level properties rather than holding them", () => {
    // Only the four protocol fields are held, so a property a peer hangs off
    // its frame rides neither into the queue's retained bytes nor past them
    // uncounted -- and the peer that drains the hold is handed the same four
    // fields a directly relayed frame would have included.
    const payload = { sdp: "v=0\r\na=group:BUNDLE 0\r\n" };
    const offer = {
      type: MessageType.OFFER,
      src: "s",
      dst: "d",
      payload,
      extra: "x".repeat(4096),
      nonce: { deep: ["y".repeat(4096)] },
    } as unknown as IMessage;

    const realm = new Realm();
    realm.addMessageToQueue("d", offer);
    const queue = realm.getMessageQueueById("d")!;

    const [held] = queue.getMessages();
    expect(Object.keys(held.message).sort()).toEqual([
      "dst",
      "payload",
      "src",
      "type",
    ]);
    expect(held.byteSize).toBe(
      2 *
        ("OFFER".length +
          "s".length +
          "d".length +
          JSON.stringify(payload).length),
    );
    expect(queue.byteSize()).toBe(held.byteSize);

    const delivered = queue.readMessage()!;
    expect(Object.keys(delivered).sort()).toEqual([
      "dst",
      "payload",
      "src",
      "type",
    ]);
    expect(delivered.payload).toEqual(payload);
  });

  test("rejects a frame with a non-string id field before it is queued", () => {
    // The id fields are typed string, but `dst` rides inside the peer's own
    // frame and is parsed from untrusted JSON; a non-string one must not slip
    // past the byte accounting (which would otherwise undercount or NaN-poison
    // the running total) or key a queue of its own. Serializing the frame throws
    // on it, so addMessageToQueue never enqueues such a frame.
    const malformed = {
      type: MessageType.OFFER,
      src: "s",
      dst: { not: "a string" },
    } as unknown as IMessage;
    expect(() => accountedBytes(malformed)).toThrow(/dst/);

    const realm = new Realm();
    expect(() => realm.addMessageToQueue(malformed.dst, malformed)).toThrow();
    expect(realm.getClientsIdsWithQueue()).toHaveLength(0);
  });

  test("refuses a malformed id before serializing the payload it came with", () => {
    // The ids are checked first, so a frame that cannot be queued at all does
    // not pay a full serialization of a quarter-megabyte structure before the
    // cheap refusal -- and the refusal an operator reads names `dst`, the one
    // leg of it a peer can drive, rather than whatever the payload happened to
    // fail on. Pinned with a payload that also has no serialized form, so the
    // two refusals compete and the id one is measured to win.
    const malformed = {
      type: MessageType.OFFER,
      src: "s",
      dst: { not: "a string" },
      payload: () => "no wire form",
    } as unknown as IMessage;

    expect(() => accountedBytes(malformed)).toThrow(/dst/);
    expect(() => accountedBytes(malformed)).not.toThrow(/serialized form/);
  });

  test("refuses a payload with no serialized form rather than sizing it zero", () => {
    // A value `JSON.stringify` leaves undefined has no form the queue can hold
    // and none it can account, and queuing it at zero bytes would put a frame
    // in the queue the byte cap never sees. It is refused instead, by the same
    // throw a malformed id takes to the dispatch-fault route.
    const unserializable = {
      type: MessageType.OFFER,
      src: "s",
      dst: "d",
      payload: () => "no wire form",
    } as unknown as IMessage;
    expect(() => accountedBytes(unserializable)).toThrow();

    const realm = new Realm();
    expect(() => realm.addMessageToQueue("d", unserializable)).toThrow();
    expect(realm.getClientsIdsWithQueue()).toHaveLength(0);
  });

  test("frees bytes as a queue is read, so a drained queue accepts again", () => {
    const realm = new Realm();
    for (let i = 0; i < 200; i += 1) {
      realm.addMessageToQueue("dst", bigOfferTo("dst"));
    }
    const queue = realm.getMessageQueueById("dst")!;
    const filled = queue.byteSize();
    expect(filled).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(filled).toBeGreaterThan(
      MAX_QUEUE_BYTES - accountedBytes(bigOfferTo("dst")),
    );

    // A reconnecting peer drains one frame; its bytes are released and a fresh
    // frame is admitted, never pushing the queue back over the cap.
    queue.readMessage();
    expect(queue.byteSize()).toBeLessThan(filled);
    realm.addMessageToQueue("dst", bigOfferTo("dst"));
    expect(queue.byteSize()).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
  });
});

describe("liveness-timeout config invariant", () => {
  // The two-tier reaper's defense depends on the short window being shorter than
  // the generous one; inverting the two would silently reap established peers and
  // spare silent ones. Pin the ordering as a check so an edit to the defaults
  // that breaks it fails here rather than in production.
  test("unconfirmed_timeout is shorter than alive_timeout", () => {
    expect(defaultConfig.unconfirmed_timeout).toBeLessThan(
      defaultConfig.alive_timeout,
    );
  });

  // The unconfirmed window must stay at least 4x the PeerJS first-heartbeat
  // cadence (PEER_PING_INTERVAL_MS, set explicitly at Peer construction, not
  // the caret-ranged `peerjs` default) so a real peer always sends a frame and
  // graduates before the window can fire, with margin for a slow socket open
  // and one missed heartbeat. This pins the margin against both values so a
  // narrowing edit fails CI.
  test("unconfirmed_timeout stays at least 4x the heartbeat cadence", () => {
    expect(defaultConfig.unconfirmed_timeout).toBeGreaterThanOrEqual(
      4 * PEER_PING_INTERVAL_MS,
    );
  });
});
