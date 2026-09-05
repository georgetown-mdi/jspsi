import { afterEach, expect, test, vi } from "vitest";

import { ConnectionError, UsageError } from "@psilink/core";

import {
  BROKER_ADDRESS_REFUSED,
  BROKER_AUTHORITY_REFUSED,
  BROKER_MESSAGE,
  INVITATION_BROKER_ADDRESS_REFUSED,
  assertDialsConfiguredBroker,
  connectToBroker,
  dialedBrokerHostAndPort,
} from "../../../src/connection/webrtc/brokerClient";
import { exitCodeForError } from "../../../src/util/exit";

import type {
  BrokerClient,
  BrokerLocation,
  BrokerMessage,
} from "../../../src/connection/webrtc/brokerClient";

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
 * verified against the real vendored broker in test/integration/webrtc/broker.test.ts.
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
async function register(options?: { signal?: AbortSignal }): Promise<{
  client: BrokerClient;
  socket: FakeSocket;
  messages: Array<BrokerMessage>;
  closes: Array<ConnectionError | undefined>;
}> {
  const messages: Array<BrokerMessage> = [];
  const closes: Array<ConnectionError | undefined> = [];
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: {
      onMessage: (message) => {
        messages.push(message);
      },
      onClose: (error) => {
        closes.push(error);
      },
    },
    socketFactory,
    signal: options?.signal,
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

test("the registration URL has the PeerJS query the broker expects", async () => {
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

// --- the address dialed -----------------------------------------------------

/** Register with `location`, returning the socket the client asked for. */
async function addressFor(location: BrokerLocation): Promise<URL> {
  sockets = [];
  const pending = connectToBroker({
    location,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory,
  });
  const socket = sockets[0];
  socket.open();
  socket.deliver({ type: BROKER_MESSAGE.open });
  await pending;
  return new URL(socket.url);
}

test("a path that could move the authority stays inside the path", async () => {
  // Measured: concatenated into the address, a path of `@attacker.example` makes
  // the configured host the userinfo of the partner's and the socket is dialed
  // at the partner's. Assigning it as a pathname is what contains it. The
  // connection resolver refuses the shape outright (webrtcDispatch.test.ts);
  // this is the layer that holds for a location reaching the client any other
  // way.
  const url = await addressFor({ ...LOCATION, path: "@attacker.example" });
  expect(url.host).toBe("signal.example:9000");
  expect(url.username).toBe("");
  expect(url.pathname).toBe("/@attacker.example/peerjs");
});

test("a path delimiter cannot open a second query or a fragment", async () => {
  const url = await addressFor({ ...LOCATION, path: "/api?x=1#f" });
  expect(url.host).toBe("signal.example:9000");
  expect(url.pathname).toBe("/api%3Fx=1%23f/peerjs");
  expect(url.searchParams.get("x")).toBeNull();
  expect(url.hash).toBe("");
});

test("an API key cannot reach past its own query parameter", async () => {
  // `key` is operator-authored -- an invitation endpoint is a strict
  // host/port/path allowlist and holds none -- and it is encoded rather than
  // interpolated, so a delimiter in it stays a character of the key.
  const url = await addressFor({
    ...LOCATION,
    key: "k&id=evil#@attacker.example",
  });
  expect(url.host).toBe("signal.example:9000");
  expect(url.searchParams.get("key")).toBe("k&id=evil#@attacker.example");
  expect(url.searchParams.get("id")).toBe(LOCAL_ID);
});

test("a host that is not a bare authority is refused, opening nothing", async () => {
  // Each shape reaches past the field: userinfo moves the dial to another host,
  // a `/` silently drops the configured port into the path, a `:` supplies a
  // second port, and whitespace or an empty value does not parse at all (the
  // connection schema requires a non-empty host, so the last is the fail-closed
  // floor rather than a reachable config).
  for (const host of [
    "evil@attacker.example",
    "signal.example/x",
    "signal.example:99",
    "bad host",
    "",
  ]) {
    sockets = [];
    const error = await connectToBroker({
      location: { ...LOCATION, host },
      id: LOCAL_ID,
      handlers: { onMessage: () => {}, onClose: () => {} },
      socketFactory,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeForError(error)).toBe(64);
    expect(sockets).toHaveLength(0);
  }
});

test("an address naming another host is refused rather than dialed", async () => {
  // The string the concatenating builder produced from the injected path, held
  // as the check's own case: it runs on the finished address, so it does not
  // depend on which builder produced it.
  const moved = (): void => {
    assertDialsConfiguredBroker(
      `ws://signal.example:9000@attacker.example/peerjs?key=peerjs&id=${LOCAL_ID}`,
      LOCATION,
    );
  };
  expect(moved).toThrow(UsageError);
  expect(moved).toThrow(BROKER_AUTHORITY_REFUSED);
  // The same exit code the host refusal above has, which is what the shared
  // class buys: every undialable-endpoint refusal reports 64, so a supervisor
  // reads "nothing was dialed, and a retry reaches the same refusal" without
  // knowing which of the sites caught it.
  let refusal: unknown;
  try {
    moved();
  } catch (err: unknown) {
    refusal = err;
  }
  expect(exitCodeForError(refusal)).toBe(64);
  // The refusal names the fields, not the address: that holds the peer id.
  expect(BROKER_AUTHORITY_REFUSED).not.toContain(LOCAL_ID);
  // And the address the client itself builds passes.
  const url = await addressFor(LOCATION);
  expect(() => {
    assertDialsConfiguredBroker(url.href, LOCATION);
  }).not.toThrow();
});

test("the consent-surface authority normalizes the host and always shows the port", async () => {
  // What an acceptance names on the surface it asks consent against. The host is
  // the parser's, as the rendezvous line's is, so the operator is never shown a
  // server the run would not contact; the port is shown even where it is the
  // scheme's default, which the authority form drops -- a consent line naming a
  // coordination server states where the dial goes rather than leaving the port
  // to a scheme the line does not state.
  // Written as escapes because one of the two is invisible in source.
  expect(
    dialedBrokerHostAndPort({
      ...LOCATION,
      host: "PEERS\u3002Example\u200B.ORG",
    }),
  ).toEqual({ host: "peers.example.org", port: 9000 });
  for (const [secure, port] of [
    [true, 443],
    [false, 80],
  ] as const)
    expect(
      dialedBrokerHostAndPort({
        ...LOCATION,
        host: "signal.example",
        port,
        secure,
      }),
    ).toEqual({ host: "signal.example", port });
  // An IPv6 literal keeps its brackets, so the port stays readable as a port.
  expect(dialedBrokerHostAndPort({ ...LOCATION, host: "[::1]" })).toEqual({
    host: "[::1]",
    port: 9000,
  });
  // The same refusal the dial makes: a host that could move the authority is not
  // rendered on a consent surface either. It names the invitation the locator
  // came from rather than a connection block this operator never authored, and
  // exits 64 as the delimiter refusal ahead of it does.
  let refusal: unknown;
  try {
    dialedBrokerHostAndPort({ ...LOCATION, host: "signal.example:9000@evil" });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(UsageError);
  expect((refusal as Error).message).toBe(INVITATION_BROKER_ADDRESS_REFUSED);
  expect(exitCodeForError(refusal)).toBe(64);
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
  // The vendored broker answers a wrong key with a plain ERROR holding this
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

test("no error the client raises has a peer id or the socket URL", async () => {
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

test("an outbound frame has only type, dst and payload", async () => {
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
  // A socket error asks the endpoint what its certificate check said before it
  // can name the failure, so the report lands a turn later; the drop behind it
  // still reports nothing.
  await vi.waitFor(() => expect(closes).toHaveLength(1));
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

test("an abort after registration is not the registration's to act on", async () => {
  // The signal cancels the registration; once the broker has confirmed it, the
  // socket belongs to the caller, whose own cancellation reports the phase the
  // abort landed in and closes what it built. This client is the FIRST abort
  // listener on that signal, so a listener left installed here would latch a
  // registration's wording onto every later abort.
  const controller = new AbortController();
  const { socket, closes } = await register({ signal: controller.signal });
  controller.abort();
  expect(closes).toHaveLength(0);
  expect(socket.closed).toBe(false);
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

test("an abort while the certificate question is out settles at once", async () => {
  // The failure path asks the endpoint what its certificate check said before
  // it can name the failure, and that question has a ceiling of its own. An
  // interrupt waits out neither it nor any other budget on this transport
  // (WEBRTC_TRANSPORT.md, Budgets), so the abort settles the registration and
  // the answer behind it reports nothing. The probe here never answers on its
  // own, so a settlement that waited for it would never come at all.
  sockets = [];
  const controller = new AbortController();
  const closes: Array<ConnectionError | undefined> = [];
  let answer: ((problem: string | undefined) => void) | undefined;
  const pending = connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: {
      onMessage: () => {},
      onClose: (error) => {
        closes.push(error);
      },
    },
    socketFactory,
    signal: controller.signal,
    certificateProbe: () =>
      new Promise<string | undefined>((resolve) => {
        answer = resolve;
      }),
  });
  sockets[0].open();
  sockets[0].fail();
  const startedAt = Date.now();
  controller.abort();
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(Date.now() - startedAt).toBeLessThan(100);
  expect(error?.kind).toBe("closed");
  expect(error?.message).toContain("cancelled");
  expect(sockets[0].closed).toBe(true);

  answer?.("DEPTH_ZERO_SELF_SIGNED_CERT");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(closes).toHaveLength(0);
});

test("a host that does not form a valid URL is a usage error, not a raw DOMException", async () => {
  // No socketFactory, so nothing stands between this host and the real
  // `new WebSocket`, which throws a DOMException on it -- an error outside the
  // taxonomy the rest of the module maintains, holding an address that holds
  // the peer id. What this holds is the refusal's shape and its silence about
  // both values, wherever in the two layers it is raised.
  const error = await connectToBroker({
    location: { ...LOCATION, host: "bad host" },
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UsageError);
  expect(exitCodeForError(error)).toBe(64);
  // The exposed error names the operator's own fields and leaks neither the
  // derived id nor the URL that holds it.
  const rendered = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
  expect(rendered).not.toContain(LOCAL_ID);
  expect(rendered).not.toContain("bad host");
});

test("a socket constructor that refuses the address raises the same usage error", async () => {
  // The second of the two layers the refusal is raised at, and the one the test
  // above cannot reach: an address the parse admits, refused by the WebSocket
  // constructor itself. One refusal wording has one exit code, so what the
  // constructor throws must be replaced rather than propagated -- its message
  // can embed the URL, which has the derived peer id, and it exits 69.
  const error = await connectToBroker({
    location: LOCATION,
    id: LOCAL_ID,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory: (url: string) => {
      throw new Error(`refused ${url}`);
    },
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UsageError);
  expect(exitCodeForError(error)).toBe(64);
  expect((error as Error).message).toBe(BROKER_ADDRESS_REFUSED);
  // The thrown error is dropped rather than attached as a cause, so neither the
  // id nor the URL that holds it reaches the rendered chain.
  expect((error as Error).cause).toBeUndefined();
  const rendered = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
  expect(rendered).not.toContain(LOCAL_ID);
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
