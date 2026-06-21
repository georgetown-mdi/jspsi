import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_MESSAGES_PER_QUEUE,
  MAX_OUTSTANDING_QUEUES,
  Realm,
} from "@peerjs-server/models/realm";
import { CheckBrokenConnections } from "@peerjs-server/services/checkBrokenConnections/index";
import { Client } from "@peerjs-server/models/client";
import { MessageType } from "@peerjs-server/enums";
import defaultConfig from "@peerjs-server/config/index";

import type { IMessage } from "@peerjs-server/models/message";

// Unit coverage for the two gap-2 controls that need no socket: the two-tier
// liveness reaper (a registered-but-never-heartbeated client is cleared well
// before the generous alive_timeout, while a client that has shown liveness keeps
// the full window), and the relay's per-destination queue bounds (a spray to many
// unregistered destinations cannot allocate queues without limit).

const ALIVE_TIMEOUT_MS = 90_000;
const UNCONFIRMED_TIMEOUT_MS = 20_000;
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
});
