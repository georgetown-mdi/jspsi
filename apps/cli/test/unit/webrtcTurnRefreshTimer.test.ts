import {
  Message,
  TurnProtocol,
  classes,
  makeIntegrityKey,
  methods,
  parseMessage,
} from "werift";
import { expect, test } from "vitest";

/**
 * The TURN allocation refresh timer, pinned because the CLI's teardown cannot
 * reach it.
 *
 * werift keeps a TURN allocation alive by re-sending REFRESH on a timer armed
 * from the lifetime the SERVER granted. Closing the peer connection stops the
 * loop from taking another turn but does not disarm the timer already waiting,
 * and that timer holds the Node event loop, so an exchange with a `turn` block
 * configured returns when the timer fires rather than when its work is done.
 * The wait is five sixths of the granted lifetime: about 500 s where a relay
 * grants the usual 600 s, which is the roughly eight minutes measured from
 * close to the process returning against coturn.
 *
 * Nothing werift exposes releases it: stopping the ICE transport, closing the
 * ICE connection, closing the TURN protocol and its transport again, and
 * resolving the refresh handle were each driven against a live allocation and
 * left the hold unchanged. The bound is therefore a stated limit
 * (docs/spec/WEBRTC_TRANSPORT.md) rather than a defect the transport can fix,
 * and this test is what says when the limit lapses: a werift release that
 * disarms the timer reddens it, and the statement comes out with it.
 */

type Address = ConstructorParameters<typeof TurnProtocol>[0];
type IceTransport = ConstructorParameters<typeof TurnProtocol>[4];

const SERVER: Address = ["127.0.0.1", 3478];
const RELAYED_ADDRESS: Address = ["127.0.0.1", 50_000];
const MAPPED_ADDRESS: Address = ["127.0.0.1", 45_000];
const USERNAME = "psilink";
const PASSWORD = "secret";
const REALM = "relay.test";
const NONCE = Buffer.from("nonce");

/** The lifetime werift itself requests, in seconds. */
const REQUESTED_LIFETIME = 600;
/** What this relay grants instead, in seconds. */
const GRANTED_LIFETIME = 1;
/** Five sixths of the grant, less the slack a loaded machine takes. */
const EARLIEST_REFRESH_MS = 700;

interface ScriptedRelay {
  transport: IceTransport;
  /** Resolves when the relay is asked for `method`; rejects at the deadline. */
  awaitRequest: (method: methods, withinMs: number) => Promise<void>;
}

/**
 * A relay that answers the long-term-credential ALLOCATE and then anything
 * else, over a transport that stays readable after `close()`. A transport that
 * reported itself closed would have werift drop the post-close request before
 * this saw it, and that request is the whole observation.
 */
function scriptedRelay(): ScriptedRelay {
  const waiting = new Map<methods, () => void>();
  const integrityKey = makeIntegrityKey(USERNAME, REALM, PASSWORD);
  let challenged = false;

  const answer = (request: Message): Message =>
    challenged
      ? new Message(
          request.messageMethod,
          classes.RESPONSE,
          request.transactionId,
        )
          .setAttribute("XOR-RELAYED-ADDRESS", RELAYED_ADDRESS)
          .setAttribute("XOR-MAPPED-ADDRESS", MAPPED_ADDRESS)
          .setAttribute("LIFETIME", GRANTED_LIFETIME)
          .addMessageIntegrity(integrityKey)
      : new Message(request.messageMethod, classes.ERROR, request.transactionId)
          .setAttribute("ERROR-CODE", [401, "Unauthorized"])
          .setAttribute("REALM", REALM)
          .setAttribute("NONCE", NONCE);

  const transport = {
    type: "udp",
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    closed: false,
    onData: (_data: Buffer, _addr: Address) => {},
    send: async (data: Buffer): Promise<void> => {
      const request = parseMessage(data);
      if (request === undefined) return;
      waiting.get(request.messageMethod)?.();
      const response = answer(request);
      challenged = true;
      setImmediate(() => {
        transport.onData(response.bytes, SERVER);
      });
    },
    close: async (): Promise<void> => {},
  };

  return {
    transport: transport as unknown as IceTransport,
    awaitRequest: (method, withinMs) =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          waiting.delete(method);
          reject(new Error(`no ${methods[method]} within ${withinMs} ms`));
        }, withinMs);
        waiting.set(method, () => {
          clearTimeout(deadline);
          waiting.delete(method);
          resolve();
        });
      }),
  };
}

test("close leaves the TURN refresh timer armed, at five sixths of the granted lifetime", async () => {
  const relay = scriptedRelay();
  const turn = new TurnProtocol(
    SERVER,
    USERNAME,
    PASSWORD,
    REQUESTED_LIFETIME,
    relay.transport,
  );

  await turn.connectionMade();
  expect(turn.relayedAddress).toEqual(RELAYED_ADDRESS);

  const closedAt = Date.now();
  await turn.close();

  // Armed from the granted second, not the requested ten minutes: five sixths
  // of the request would land far outside this budget.
  await relay.awaitRequest(methods.REFRESH, 10_000);
  expect(Date.now() - closedAt).toBeGreaterThanOrEqual(EARLIEST_REFRESH_MS);
}, 15_000);
