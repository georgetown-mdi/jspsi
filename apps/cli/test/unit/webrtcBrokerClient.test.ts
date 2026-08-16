import { afterEach, expect, test, vi } from "vitest";

import { ConnectionError } from "@psilink/core";

import {
  BROKER_MESSAGE,
  connectToBroker,
} from "../../src/connection/webrtc/brokerClient";

import type {
  BrokerClient,
  BrokerLocation,
  BrokerMessage,
} from "../../src/connection/webrtc/brokerClient";

const LOCATION: BrokerLocation = {
  host: "signal.example",
  port: 9000,
  path: "/api",
  key: "peerjs",
  secure: false,
};

const LOCAL_ID = "aaaa0000aaaa0000aaaa0000aaaa0000";
const REMOTE_ID = "bbbb1111bbbb1111bbbb1111bbbb1111";

/**
 * A WebSocket stand-in with the surface the broker client uses. It drives the
 * client's whole state machine -- registration, refusal, steady state, teardown
 * -- with no broker, so the unit tests stay fast and hermetic; the wire itself is
 * verified against the real vendored broker in test/integration/webrtcBroker.test.ts.
 */
class FakeSocket {
  static readonly OPEN = 1;

  readyState = 0;
  readonly url: string;
  readonly sent: Array<string> = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** The socket handshake completed; registration has not been confirmed yet. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  /** One inbound frame, as text, exactly as the broker sends it. */
  deliver(message: Record<string, unknown> | string): void {
    this.emit("message", {
      data: typeof message === "string" ? message : JSON.stringify(message),
    });
  }

  fail(): void {
    this.emit("error", {});
  }

  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  /** The parsed frames this socket was asked to send. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

let sockets: Array<FakeSocket> = [];

const socketFactory = (url: string): WebSocket => {
  const socket = new FakeSocket(url);
  sockets.push(socket);
  return socket as unknown as WebSocket;
};

/** Register a client and hand back both ends plus what it observed. */
async function register(options?: {
  onMessage?: (message: BrokerMessage) => void;
  onClose?: (error?: ConnectionError) => void;
  id?: string;
}): Promise<{
  client: BrokerClient;
  socket: FakeSocket;
  messages: Array<BrokerMessage>;
  closes: Array<ConnectionError | undefined>;
}> {
  const messages: Array<BrokerMessage> = [];
  const closes: Array<ConnectionError | undefined> = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: options?.id ?? LOCAL_ID,
    handlers: {
      onMessage: (message) => {
        messages.push(message);
        options?.onMessage?.(message);
      },
      onClose: (error) => {
        closes.push(error);
        options?.onClose?.(error);
      },
    },
    socketFactory,
  });
  const socket = sockets[sockets.length - 1];
  socket.open();
  socket.deliver({ type: BROKER_MESSAGE.open });
  return { client: await pending, socket, messages, closes };
}

afterEach(() => {
  sockets = [];
  vi.useRealTimers();
});

// --- registration -----------------------------------------------------------

test("the registration URL carries the PeerJS query the broker expects", async () => {
  const { socket } = await register();
  const url = new URL(socket.url);
  expect(url.protocol).toBe("ws:");
  expect(url.host).toBe("signal.example:9000");
  expect(url.pathname).toBe("/api/peerjs");
  expect(url.searchParams.get("key")).toBe("peerjs");
  expect(url.searchParams.get("id")).toBe(LOCAL_ID);
  expect(url.searchParams.get("version")).toBe("1.5.5");
  // The token distinguishes an id collision from a reconnect of the same
  // client, so it must not be predictable or empty.
  expect(url.searchParams.get("token")).toMatch(/^[0-9a-f]{32}$/);
});

test("a root-mounted broker does not gain a doubled path separator", async () => {
  sockets = [];
  const pending = connectToBroker({
    location: { ...LOCATION, path: "/" },
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
  });
  const socket = sockets[0];
  socket.open();
  socket.deliver({ type: BROKER_MESSAGE.open });
  await pending;
  expect(new URL(socket.url).pathname).toBe("/peerjs");
});

test("registration resolves only on the server's OPEN, not on the socket opening", async () => {
  sockets = [];
  let resolved = false;
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
  }).then((client) => {
    resolved = true;
    return client;
  });
  const socket = sockets[0];
  socket.open();
  await Promise.resolve();
  expect(resolved).toBe(false);
  socket.deliver({ type: BROKER_MESSAGE.open });
  await pending;
  expect(resolved).toBe(true);
});

test("two distinct registrations use distinct tokens", async () => {
  const first = await register();
  const second = await register();
  expect(new URL(first.socket.url).searchParams.get("token")).not.toBe(
    new URL(second.socket.url).searchParams.get("token"),
  );
});

// --- the role-collision signal ----------------------------------------------

test("ID-TAKEN becomes an error naming the role misconfiguration", async () => {
  sockets = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
  });
  const socket = sockets[0];
  socket.open();
  socket.deliver({
    type: BROKER_MESSAGE.idTaken,
    payload: { msg: "ID is taken" },
  });
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error?.kind).toBe("usage");
  expect(error?.message).toContain("already registered");
  expect(error?.message).toContain("inviter");
  expect(error?.message).toContain("acceptor");
  expect(error?.message).toContain("role");
  // Not a generic timeout: the socket is closed at once rather than left to
  // stall until a dial deadline.
  expect(socket.closed).toBe(true);
});

test.each([
  ["the INVALID-KEY type", { type: BROKER_MESSAGE.invalidKey }],
  // The vendored broker answers a wrong key with a plain ERROR carrying this
  // wording rather than the dedicated type; both routes must reach the same fix.
  [
    "a generic ERROR carrying the broker's invalid-key wording",
    { type: BROKER_MESSAGE.error, payload: { msg: "Invalid key provided" } },
  ],
])(
  "an invalid API key named by %s points at the field to fix",
  async (_label, frame) => {
    sockets = [];
    const pending = connectToBroker({
      location: LOCATION,
      id: LOCAL_ID,
      handlers: { onMessage: () => {}, onClose: () => {} },
      socketFactory,
    });
    sockets[0].open();
    sockets[0].deliver(frame);
    const error = await pending.then(
      () => undefined,
      (err: unknown) => err as ConnectionError,
    );
    expect(error?.kind).toBe("usage");
    expect(error?.message).toContain("key");
  },
);

// --- peer-id and server-text hygiene ----------------------------------------

test("no error the client raises carries a peer id or the socket URL", async () => {
  const raised: Array<ConnectionError> = [];
  for (const frame of [
    {
      type: BROKER_MESSAGE.idTaken,
      payload: { msg: `ID "${LOCAL_ID}" is taken` },
    },
    { type: BROKER_MESSAGE.invalidKey },
    { type: BROKER_MESSAGE.error, payload: { msg: `no peer ${REMOTE_ID}` } },
  ]) {
    sockets = [];
    const pending = connectToBroker({
      location: LOCATION,
      id: LOCAL_ID,
      handlers: { onMessage: () => {}, onClose: () => {} },
      socketFactory,
    });
    sockets[0].open();
    sockets[0].deliver(frame);
    const error = await pending.then(
      () => undefined,
      (err: unknown) => err as ConnectionError,
    );
    if (error) raised.push(error);
  }
  expect(raised).toHaveLength(3);
  for (const error of raised) {
    const rendered = `${error.message} ${error.stack ?? ""}`;
    expect(rendered).not.toContain(LOCAL_ID);
    expect(rendered).not.toContain(REMOTE_ID);
    expect(rendered).not.toContain("token=");
    expect(rendered).not.toContain("signal.example");
  }
});

test("a server ERROR payload's free text is not echoed to the operator", async () => {
  sockets = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
  });
  sockets[0].open();
  sockets[0].deliver({
    type: BROKER_MESSAGE.error,
    payload: { msg: "[31mADVERSARY TEXT[0m" },
  });
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(error?.message).not.toContain("ADVERSARY");
  expect(error?.message).not.toContain("");
});

// --- steady state -----------------------------------------------------------

test("an outbound frame carries only type, dst and payload", async () => {
  const { client, socket } = await register();
  client.send({
    type: BROKER_MESSAGE.offer,
    dst: REMOTE_ID,
    payload: { connectionId: "dc_1" },
  });
  const offer = socket
    .sentFrames()
    .find((frame) => frame.type === BROKER_MESSAGE.offer);
  expect(offer).toEqual({
    type: BROKER_MESSAGE.offer,
    dst: REMOTE_ID,
    payload: { connectionId: "dc_1" },
  });
  // The server stamps `src` itself; sending one would be redundant at best.
  expect(offer).not.toHaveProperty("src");
});

test("signaling frames reach the handler with the server-stamped src", async () => {
  const { socket, messages } = await register();
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: REMOTE_ID,
    dst: LOCAL_ID,
    payload: { sdp: { type: "answer", sdp: "v=0\r\n" }, connectionId: "dc_1" },
  });
  expect(messages).toHaveLength(1);
  expect(messages[0].type).toBe(BROKER_MESSAGE.answer);
  expect(messages[0].src).toBe(REMOTE_ID);
});

test("heartbeats go up at the pinned cadence", async () => {
  vi.useFakeTimers();
  sockets = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
    heartbeatIntervalMs: 5_000,
  });
  const socket = sockets[0];
  socket.open();
  socket.deliver({ type: BROKER_MESSAGE.open });
  await pending;
  vi.advanceTimersByTime(15_000);
  const beats = socket
    .sentFrames()
    .filter((frame) => frame.type === BROKER_MESSAGE.heartbeat);
  // Three windows elapsed. The broker reaps a registered socket that stays
  // silent, so a missing beat is a dropped exchange, not a cosmetic gap.
  expect(beats).toHaveLength(3);
});

test("a frame that is not a signaling message is dropped, not fatal", async () => {
  const { socket, messages, closes } = await register();
  socket.deliver({ payload: { sdp: "no type field" } });
  socket.deliver("[1,2,3]");
  socket.deliver({ type: 7 });
  expect(messages).toHaveLength(0);
  expect(closes).toHaveLength(0);
});

test("a non-JSON frame ends the connection without echoing the body", async () => {
  const { socket, closes } = await register();
  socket.deliver("}{ NOT-JSON-MARKER");
  expect(closes).toHaveLength(1);
  expect(closes[0]?.kind).toBe("protocol");
  expect(closes[0]?.message).not.toContain("NOT-JSON-MARKER");
  expect(socket.closed).toBe(true);
});

test("an oversized frame is refused before it is parsed", async () => {
  const { socket, closes } = await register();
  socket.deliver(`"${"x".repeat(256 * 1024 + 1)}"`);
  expect(closes[0]?.kind).toBe("protocol");
  expect(closes[0]?.message).toContain("limit");
});

// --- teardown ---------------------------------------------------------------

test("a dropped socket reports a transport failure once", async () => {
  const { socket, closes } = await register();
  socket.fail();
  socket.drop();
  expect(closes).toHaveLength(1);
  expect(closes[0]?.kind).toBe("transport");
});

test("a local close is silent and idempotent", async () => {
  const { client, socket, closes } = await register();
  client.close();
  client.close();
  expect(closes).toHaveLength(0);
  expect(socket.closed).toBe(true);
  // A send after close is a no-op rather than a throw: the owner may be
  // unwinding concurrently.
  const before = socket.sent.length;
  client.send({ type: BROKER_MESSAGE.leave, dst: REMOTE_ID });
  expect(socket.sent).toHaveLength(before);
});

test("a close after teardown does not deliver another inbound frame", async () => {
  const { socket, messages } = await register();
  socket.drop();
  socket.deliver({ type: BROKER_MESSAGE.answer, src: REMOTE_ID });
  expect(messages).toHaveLength(0);
});

test("an abort before registration rejects and closes the socket", async () => {
  sockets = [];
  const controller = new AbortController();
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
    signal: controller.signal,
  });
  sockets[0].open();
  controller.abort();
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(error?.kind).toBe("closed");
  expect(sockets[0].closed).toBe(true);
});

test("a host that does not form a valid URL is a usage error, not a raw DOMException", async () => {
  // No socketFactory: the real `new WebSocket` throws a DOMException synchronously
  // on this host, which without wrapping would escape the ConnectionError
  // taxonomy the rest of the module maintains.
  const error = await connectToBroker({
    location: { ...LOCATION, host: "bad host" },
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
  }).then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error?.kind).toBe("usage");
  // The surfaced error names the operator's own fields and leaks neither the
  // derived id nor the URL that carries it.
  const rendered = `${error?.message} ${error?.stack ?? ""}`;
  expect(rendered).not.toContain(LOCAL_ID);
  expect(rendered).not.toContain("bad host");
});

test("a registration that is never confirmed times out", async () => {
  vi.useFakeTimers();
  sockets = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
    openTimeoutMs: 1_000,
  });
  sockets[0].open();
  vi.advanceTimersByTime(1_001);
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(error?.kind).toBe("transport");
  expect(error?.message).toContain("1000ms");
  expect(sockets[0].closed).toBe(true);
});
