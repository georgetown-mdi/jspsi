import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MessageType } from "@psilink/peerjs-broker/enums";
import { MessagesExpire } from "@psilink/peerjs-broker/services/messagesExpire/index";
import { Realm } from "@psilink/peerjs-broker/models/realm";

import type { IClient } from "@psilink/peerjs-broker/models/client";
import type { IMessage } from "@psilink/peerjs-broker/models/message";
import type { SerializedFrame } from "@psilink/peerjs-broker/models/messageQueue";

// The expiry sweep behind the relay's hold-for-reconnect queues: a queue whose
// destination never came back for it is cleared on a timer, and each sender is
// told once that what it addressed there is gone. The queues hold frames in
// serialized form, so the sweep is also where a payload could be parsed on a
// path that has no reason to look at one -- it reads routing ids only, which is
// pinned below rather than asserted in a comment.

/** The destination that never returns, and the two peers that addressed it. */
const ABSENT_ID = "peer-absent";
const SENDER_ID = "peer-sender";
const OTHER_SENDER_ID = "peer-other";

/** Scaled-down production shape (seconds there): the sweep runs several times
 * inside one read-cold window, so a queue can be watched being spared by a real
 * sweep before it is cleared by one. */
const CLEANUP_INTERVAL_MS = 20;
const EXPIRE_TIMEOUT_MS = 100;

function offerFrom(src: string, payload: unknown): IMessage {
  return {
    type: MessageType.OFFER,
    src,
    dst: ABSENT_ID,
    payload,
  } as unknown as IMessage;
}

/** A frame in the form the queue holds one, stamped as held-JSON but holding
 * text that is not JSON -- so any read of it throws where a real held frame's
 * would not. Built by hand: the held text is the server's own serialization, so
 * nothing a peer sends produces this. */
function poisonedFrameFrom(src: string): SerializedFrame {
  const payload = "{ not json";
  return {
    message: { type: MessageType.OFFER, src, dst: ABSENT_ID, payload },
    byteSize:
      2 *
      (MessageType.OFFER.length +
        src.length +
        ABSENT_ID.length +
        payload.length),
    payloadKind: "json",
  };
}

/** A stand-in for the broker's message handler that records what the sweep
 * hands it: the notices are the sweep's only output, so they are read here. */
function recordingHandler(): {
  handled: Array<IMessage>;
  handle: (client: IClient | undefined, message: IMessage) => boolean;
} {
  const handled: Array<IMessage> = [];
  return {
    handled,
    handle(_client: IClient | undefined, message: IMessage): boolean {
      handled.push(message);
      return true;
    },
  };
}

function runSweep(
  realm: Realm,
  advanceMs: number,
): { handled: Array<IMessage> } {
  const messageHandler = recordingHandler();
  const expiry = new MessagesExpire({
    realm,
    config: {
      cleanup_out_msgs: CLEANUP_INTERVAL_MS,
      expire_timeout: EXPIRE_TIMEOUT_MS,
    },
    messageHandler,
  });
  expiry.startMessagesExpiration();
  try {
    vi.advanceTimersByTime(advanceMs);
  } finally {
    expiry.stopMessagesExpiration();
  }
  return { handled: messageHandler.handled };
}

describe("relay queue expiry sweep", () => {
  // Fake timers drive both the sweep's own setTimeout loop and the `new Date()`
  // clock its read-cold threshold compares a queue's last read against.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("clears a read-cold queue and tells each sender once", () => {
    const realm = new Realm();
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(SENDER_ID, { sdp: "v=0\r\n" }),
    );
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(SENDER_ID, {
        candidate: "candidate:1 1 udp 1 127.0.0.1 1 typ host",
      }),
    );
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(OTHER_SENDER_ID, { sdp: "v=0\r\na=group:BUNDLE 0\r\n" }),
    );

    const { handled } = runSweep(
      realm,
      EXPIRE_TIMEOUT_MS + CLEANUP_INTERVAL_MS,
    );

    expect(realm.getMessageQueueById(ABSENT_ID)).toBeUndefined();
    expect(realm.getClientsIdsWithQueue()).toHaveLength(0);
    // One notice per sender, addressed back the way the held frame came, and
    // holding nothing but the two ids the frame was held with -- no payload
    // rides back out on the expiry path.
    expect(handled).toEqual([
      { type: MessageType.EXPIRE, src: ABSENT_ID, dst: SENDER_ID },
      { type: MessageType.EXPIRE, src: ABSENT_ID, dst: OTHER_SENDER_ID },
    ]);
  });

  test("leaves a queue that is not yet read-cold standing", () => {
    const realm = new Realm();
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(SENDER_ID, { sdp: "v=0\r\n" }),
    );

    // Several sweeps run, but the queue was filled less than expire_timeout
    // ago, so a peer still on its way back finds its frame waiting.
    const { handled } = runSweep(
      realm,
      EXPIRE_TIMEOUT_MS - CLEANUP_INTERVAL_MS,
    );

    expect(realm.getMessageQueueById(ABSENT_ID)?.size()).toBe(1);
    expect(handled).toEqual([]);
  });

  test("expires a queue holding a frame whose payload cannot be parsed", () => {
    // A frame stamped as held-JSON whose text is not JSON: reading it out
    // throws, so a sweep that touched payloads at all would fail here rather
    // than quietly work. It is planted rather than sent, the held text being
    // the server's own serialization; the sweep clears the queue and builds
    // both notices from the routing ids alone.
    const realm = new Realm();
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(SENDER_ID, { sdp: "v=0\r\n" }),
    );
    const queue = realm.getMessageQueueById(ABSENT_ID)!;
    queue.addMessage(poisonedFrameFrom(OTHER_SENDER_ID));

    const { handled } = runSweep(
      realm,
      EXPIRE_TIMEOUT_MS + CLEANUP_INTERVAL_MS,
    );

    expect(realm.getMessageQueueById(ABSENT_ID)).toBeUndefined();
    expect(handled).toEqual([
      { type: MessageType.EXPIRE, src: ABSENT_ID, dst: SENDER_ID },
      { type: MessageType.EXPIRE, src: ABSENT_ID, dst: OTHER_SENDER_ID },
    ]);
  });

  test("the frame planted above is one a read really cannot parse", () => {
    // The planted frame is unparseable on the read path the drain takes,
    // not merely assumed to be.
    const realm = new Realm();
    realm.addMessageToQueue(
      ABSENT_ID,
      offerFrom(SENDER_ID, { sdp: "v=0\r\n" }),
    );
    const queue = realm.getMessageQueueById(ABSENT_ID)!;
    queue.addMessage(poisonedFrameFrom(OTHER_SENDER_ID));

    queue.readMessage();
    expect(() => queue.readMessage()).toThrow();
  });
});
