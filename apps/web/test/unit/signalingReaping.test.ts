import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_MESSAGES_PER_QUEUE,
  MAX_OUTSTANDING_QUEUES,
  MAX_QUEUE_BYTES,
  Realm,
} from "@peerjs-server/models/realm";
import { CheckBrokenConnections } from "@peerjs-server/services/checkBrokenConnections/index";
import { Client } from "@peerjs-server/models/client";
import { MessageType } from "@peerjs-server/enums";
import { PEER_PING_INTERVAL_MS } from "@psi/rendezvous";
import defaultConfig from "@peerjs-server/config/index";
import { messageByteSize } from "@peerjs-server/models/messageQueue";

import type { IMessage } from "@peerjs-server/models/message";

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
      MAX_QUEUE_BYTES - messageByteSize(bigOfferTo("dst")),
    );
  });

  test("counts resident (UTF-16) bytes, so a non-Latin1 payload cannot evade the cap", () => {
    // V8 stores a string as two bytes per character once it holds any non-Latin1
    // character, so an all-`Ā` payload and an equal-length ASCII payload
    // have the same heap residency. messageByteSize must size them identically;
    // a UTF-8 measure would call the ASCII one half the size and let a wide
    // payload occupy ~2x the cap while measuring under it.
    const base = { type: MessageType.OFFER, src: "s", dst: "d" } as const;
    const ascii: IMessage = {
      ...base,
      payload: "a".repeat(FRAME_PAYLOAD_CHARS),
    };
    const wide: IMessage = {
      ...base,
      payload: "Ā".repeat(FRAME_PAYLOAD_CHARS),
    };
    expect(messageByteSize(ascii)).toBe(messageByteSize(wide));
    expect(messageByteSize(wide)).toBe(
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

  test("rejects a frame with a non-string payload before it is queued", () => {
    // payload is typed string, but the inbound frame is parsed from untrusted
    // JSON; a non-string payload must not slip past the byte accounting (which
    // would otherwise undercount or NaN-poison the running total). messageByteSize
    // throws on it, so addMessageToQueue never enqueues such a frame.
    const malformed = {
      type: MessageType.OFFER,
      src: "s",
      dst: "d",
      payload: { not: "a string" },
    } as unknown as IMessage;
    expect(() => messageByteSize(malformed)).toThrow();

    const realm = new Realm();
    expect(() => realm.addMessageToQueue("d", malformed)).toThrow();
    expect(realm.getMessageQueueById("d")).toBeUndefined();
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
      MAX_QUEUE_BYTES - messageByteSize(bigOfferTo("dst")),
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

  // The unconfirmed window's safety argument is that it is at least 4x the PeerJS
  // first-heartbeat cadence, so a real peer always sends a frame and graduates to
  // the generous window before it can fire (4x leaves margin for a slow socket
  // open and one missed heartbeat). The cadence is now psilink-owned -- set
  // explicitly at Peer construction (PEER_PING_INTERVAL_MS) rather than left to
  // the caret-ranged `peerjs` default -- so pin the margin against both values
  // here: a future edit to either the reap window or the cadence that narrows it
  // below 4x fails CI rather than silently shrinking the headroom that justifies
  // the window.
  test("unconfirmed_timeout stays at least 4x the heartbeat cadence", () => {
    expect(defaultConfig.unconfirmed_timeout).toBeGreaterThanOrEqual(
      4 * PEER_PING_INTERVAL_MS,
    );
  });
});
