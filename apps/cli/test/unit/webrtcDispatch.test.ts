import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";

import type {
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
} from "@psilink/core";

/**
 * `runProtocol`'s webrtc dispatch: the branch that runs the exchange over a data
 * channel instead of a shared folder.
 *
 * The wire below it is driven for real elsewhere -- two werift peers through the
 * vendored broker in test/integration/webrtc/transport.test.ts. What is only
 * observable here is what the dispatch itself decides: that it dials rather than
 * opening a file-sync connection, what it hands the rendezvous, which handshake
 * role each party takes from its configured one, and that the exchange runs
 * unwrapped over the channel's own confidentiality. The two parties run against
 * each other over a pair of in-memory connections, so the key exchange those
 * decisions feed is the real one.
 */

const mockState = vi.hoisted(() => ({
  /** Every rendezvous the dispatch asked for, in call order. */
  dials: [] as Array<Record<string, unknown>>,
  /** What each party asked the key exchange for, attributed to its side. */
  handshakes: [] as Array<{
    side: "inviter" | "acceptor";
    role: string;
    requestEncryption: boolean;
  }>,
  /** The connection each party's runExchange was handed. */
  exchangeConnections: [] as Array<unknown>,
  /** Every `log.info` line the run emitted, with its arguments joined as a console joins them. */
  logLines: [] as Array<string>,
}));

vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Keep the key exchange real: the role mapping is only meaningful if a genuine
// initiator/responder handshake completes over it. Capture the info lines (one
// of them is asserted below), silence the rest, and stub the PSI exchange, which
// would otherwise need the WASM stack and a dataset.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  const stubLinkageTerms = actual.getDefaultLinkageTerms("Acceptor");
  return {
    ...actual,
    getLogger: (_name: string) => ({
      info: (...parts: Array<unknown>) => {
        mockState.logLines.push(parts.map((part) => String(part)).join(" "));
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
    }),
    authenticateConnection: vi.fn(
      async (
        connection: MessageConnection,
        params: Parameters<typeof actual.authenticateConnection>[1],
        role: Parameters<typeof actual.authenticateConnection>[2],
        requestEncryption: boolean,
      ) => {
        // The linked pair below hands each party its own connection object, so
        // identity is what attributes a captured handshake to the side that ran
        // it -- the argument list itself carries no party name.
        mockState.handshakes.push({
          side: connection === pair.inviter ? "inviter" : "acceptor",
          role,
          requestEncryption,
        });
        return actual.authenticateConnection(
          connection,
          params,
          role,
          requestEncryption,
        );
      },
    ),
    runExchange: vi.fn(async (connection: unknown) => {
      mockState.exchangeConnections.push(connection);
      return {
        associationTable: [[], []],
        intersectionCount: undefined,
        partnerTerms: stubLinkageTerms,
        resolvedRole: "receiver",
        partnerPayload: { columns: [], rowIndices: [], rows: [] },
      } satisfies ExchangeResult;
    }),
    describeExchangeStages: vi.fn().mockReturnValue([]),
    buildOutputTable: vi.fn().mockReturnValue({ headers: [], rows: [] }),
  };
});

// The transport itself is stood up by its own suites; here it is replaced by a
// pair of in-memory connections so the dispatch's inputs and the handshake it
// drives are what the run depends on.
vi.mock("../../src/connection/webrtc/webrtcMessageConnection", async () => ({
  openWebRtcMessageConnection: vi.fn(
    async (options: Record<string, unknown>) => {
      mockState.dials.push(options);
      return linkedConnection(options.role as "inviter" | "acceptor");
    },
  ),
}));

// The SFTP adapter must never be constructed on this channel; importing the real
// one would also pull ssh2 into a suite that has no server.
vi.mock("../../src/connection/ssh2SftpAdapter", () => ({
  SSH2SFTPClientAdapter: vi.fn(() => {
    throw new Error("the webrtc dispatch must not build an SFTP client");
  }),
}));

const { openWebRtcMessageConnection } =
  await import("../../src/connection/webrtc/webrtcMessageConnection");
const {
  runProtocol,
  webRtcDialFrom,
  WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
  WEBRTC_ROLE_REQUIRED,
} = await import("../../src/protocol");
const { WEBRTC_URL_REFUSED, WEBRTC_URL_EXTRAS_REFUSED } =
  await import("../../src/connectionFromUrl");
const { BROKER_ADDRESS_REFUSED, ID_TAKEN_MESSAGE } =
  await import("../../src/connection/webrtc/brokerClient");
const { exitCodeForError } = await import("../../src/util/exit");
const { WEBRTC_BROKER_HOST_REFUSED, WEBRTC_BROKER_PATH_REFUSED } =
  await import("../../src/connection/webrtc/weriftPeer");
const { saveKeyFile } = await import("../../src/keyFile");
const {
  DISPLAY_TRUNCATION_MARKER,
  StandardizedDataset,
  UsageError,
  generateSharedSecret,
  getDefaultLinkageTerms,
  sanitizeErrorForDisplay,
} = await import("@psilink/core");

/**
 * A pair of connections wired to each other: what one sends the other receives,
 * in order. Enough for the key exchange, which is a strict lockstep of whole
 * values.
 */
function linkedPair(): Record<"inviter" | "acceptor", MessageConnection> {
  const queues: Record<string, Array<unknown>> = { inviter: [], acceptor: [] };
  const waiters: Record<string, Array<(value: unknown) => void>> = {
    inviter: [],
    acceptor: [],
  };
  const deliver = (to: string, value: unknown): void => {
    const waiter = waiters[to].shift();
    if (waiter) waiter(value);
    else queues[to].push(value);
  };
  const side = (self: string, peer: string): MessageConnection => ({
    send: async (value: unknown) => {
      deliver(peer, value);
    },
    receive: async () => {
      const queued = queues[self].shift();
      if (queued !== undefined) return queued;
      return new Promise((resolve) => waiters[self].push(resolve));
    },
    close: async () => {},
    setInboundFrameCap: () => {},
  });
  return {
    inviter: side("inviter", "acceptor"),
    acceptor: side("acceptor", "inviter"),
  };
}

let pair: ReturnType<typeof linkedPair>;
function linkedConnection(role: "inviter" | "acceptor"): MessageConnection {
  return pair[role];
}

const minimalPrepared = {
  metadata: [],
  linkageTerms: getDefaultLinkageTerms("Inviter"),
  dataset: new StandardizedDataset([], []),
  rawRows: [],
  rowCount: 0,
} satisfies PreparedExchange;
const SECRET = generateSharedSecret();

/** The cross-app conformance fixture: each rendezvous side's key-exchange
 * handshake role and request-encryption flag, pinned once for both apps. */
const interopVectors = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
      import.meta.url,
    ),
    { encoding: "utf8" },
  ),
) as {
  rendezvous: {
    sides: Array<{
      side: "inviter" | "acceptor";
      handshakeRole: string;
      requestEncryption: boolean;
    }>;
  };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-webrtc-dispatch-"));
  pair = linkedPair();
  mockState.dials.length = 0;
  mockState.handshakes.length = 0;
  mockState.exchangeConnections.length = 0;
  mockState.logLines.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const BROKER_HOST = "peers.example.org";

function webrtcConnection(role: "inviter" | "acceptor", host = BROKER_HOST) {
  return {
    channel: "webrtc" as const,
    server: { host, port: 9000, secure: false },
    role,
    stun: ["stun:stun.example.org:3478"],
  };
}

/** Run one party end to end over the linked pair. */
function runParty(
  role: "inviter" | "acceptor",
  host = BROKER_HOST,
): Promise<unknown> {
  const keyFilePath = path.join(tmpDir, `${role}.key`);
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  return runProtocol({
    connection: webrtcConnection(role, host),
    auth: { sharedSecret: SECRET, keyFilePath },
    prepared: minimalPrepared,
    output: path.join(tmpDir, `${role}.csv`),
    verbosity: -1,
    loggerName: "test",
  });
}

// --- the dispatch -----------------------------------------------------------

test("both parties complete an authenticated exchange over the data channel", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);

  // The handshake ran for real: each side persisted a rotated token, which only
  // a completed key exchange over the paired transport can produce.
  for (const role of ["inviter", "acceptor"]) {
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, `${role}.key`), "utf8"),
    ) as { sharedSecret: string };
    expect(saved.sharedSecret).not.toBe(SECRET);
  }
  expect(mockState.exchangeConnections).toHaveLength(2);
});

test("the configured role fixes the handshake role, complementary across the pair", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  // The acceptor dials the channel and sends first, so it is the initiator; the
  // inviter listens and answers. A browser peer maps the two the same way, which
  // is what lets a CLI peer meet one.
  expect(mockState.handshakes.map((h) => h.role).sort()).toEqual([
    "initiator",
    "responder",
  ]);
});

test("neither party asks for the application-layer AEAD, and neither wraps", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  // A data channel is already end-to-end confidential under DTLS, and a browser
  // peer refuses a partner that requests the wrap, so asking would cost the
  // exchange rather than protect it.
  expect(mockState.handshakes.every((h) => !h.requestEncryption)).toBe(true);
  // And the negotiated decision is what the exchange actually ran under: the
  // connection handed to runExchange is the transport itself, not a decorator
  // over it.
  expect(mockState.exchangeConnections).toHaveLength(2);
  for (const connection of mockState.exchangeConnections)
    expect([pair.inviter, pair.acceptor]).toContain(connection);
});

test("each party's role and encryption request match the shared interop vectors", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  // The two assertions above hold the CLI to its own reading of the pairing;
  // this one holds it to the shared cross-app vectors the web app's suite
  // asserts its own side against (apps/web/test/unit/webrtcInterop.test.ts), so
  // the two apps cannot agree with themselves and disagree with each other. The
  // rest of the CLI's side of that fixture is driven in webrtcInterop.test.ts;
  // the request-encryption flag is only observable through a real handshake,
  // which this file already drives.
  const bySide = new Map(mockState.handshakes.map((h) => [h.side, h]));
  expect(bySide.size).toBe(interopVectors.rendezvous.sides.length);
  for (const side of interopVectors.rendezvous.sides)
    expect(bySide.get(side.side)).toMatchObject({
      role: side.handshakeRole,
      requestEncryption: side.requestEncryption,
    });
});

test("the rendezvous is dialed with the configured broker and ICE servers", async () => {
  await Promise.all([runParty("inviter"), runParty("acceptor")]);
  for (const dial of mockState.dials) {
    expect(dial.location).toEqual({
      host: "peers.example.org",
      port: 9000,
      path: "/",
      key: "peerjs",
      secure: false,
    });
    expect(dial.iceServers).toEqual([{ urls: ["stun:stun.example.org:3478"] }]);
    expect(dial.sharedSecret).toBe(SECRET);
  }
  expect(mockState.dials.map((d) => d.role).sort()).toEqual([
    "acceptor",
    "inviter",
  ]);
});

test("the rendezvous line names the authority dialed, not the configured text", async () => {
  // The URL parser rewrites a host before anything is dialed: it lowercases,
  // folds U+3002 onto the label separator, and deletes an ignorable such as
  // U+200B. Logging the configured text would name a server the run never
  // contacted -- and disagree with the socket's own authority check, which
  // compares against exactly this parsed form. Both are written as escapes
  // because one of the two is invisible in source.
  const host = "PEERS\u3002Example\u200B.ORG";
  await Promise.all([runParty("inviter", host), runParty("acceptor", host)]);
  const rendezvousLine = "rendezvousing through the signaling server at";
  expect(
    mockState.logLines.filter((line) => line.startsWith(rendezvousLine)),
  ).toEqual([
    `${rendezvousLine} peers.example.org:9000`,
    `${rendezvousLine} peers.example.org:9000`,
  ]);
});

test("a signal during the rendezvous closes the channel it opened", async () => {
  // The interrupt handler's cleanup runs while the dial is still in flight, so
  // it finds no transport to close. Whatever the dial then returns would be left
  // standing -- a registered id and an open channel -- unless the dispatch closes
  // it itself once it has one.
  const keyFilePath = path.join(tmpDir, "signal.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  let closed = 0;
  vi.mocked(openWebRtcMessageConnection).mockImplementationOnce(async () => {
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ...pair.inviter,
      close: async () => {
        closed += 1;
      },
    };
  });
  // The signal handler exits the process on a real run; here it must return so
  // the run under test can finish.
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await runProtocol({
      connection: webrtcConnection("inviter"),
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "signal.csv"),
      verbosity: -1,
      loggerName: "test",
    });
  } finally {
    exit.mockRestore();
  }
  expect(closed).toBeGreaterThan(0);
  // And no handshake was attempted over it.
  expect(mockState.handshakes).toHaveLength(0);
});

test("a signal cancels a rendezvous that is still in flight", async () => {
  // The guard above can only act once the dial settles, and a rendezvous waiting
  // for a partner settles no sooner than its own budget -- ten minutes by
  // default -- so an interrupt during one would leave the broker socket and the
  // half-negotiated peer connection standing until then. The transport takes an
  // AbortSignal wired to fail-and-teardown for exactly this; what is asserted
  // here is that the run hands it one and that firing it is what ends the dial.
  const keyFilePath = path.join(tmpDir, "cancel.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  let dialSignal: AbortSignal | undefined;
  let toreDown = false;
  vi.mocked(openWebRtcMessageConnection).mockImplementationOnce(
    async (options) => {
      dialSignal = options.signal;
      // Stands in for the transport's own abort wiring: openWebRtcPeerSession
      // fails the negotiation and tears down what it built before rejecting.
      const cancelled = new Promise<MessageConnection>((_resolve, reject) => {
        // A dial handed no signal has nothing to end it, which is the defect
        // this covers; reject rather than park on it, so that case fails here
        // and now instead of spending the suite's timeout.
        if (options.signal === undefined) {
          reject(new Error("the rendezvous was handed no signal"));
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            toreDown = true;
            reject(new Error("the WebRTC rendezvous was cancelled"));
          },
          { once: true },
        );
      });
      process.emit("SIGINT");
      return await cancelled;
    },
  );
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await runProtocol({
      connection: webrtcConnection("inviter"),
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "cancel.csv"),
      verbosity: -1,
      loggerName: "test",
    });
  } finally {
    exit.mockRestore();
  }
  expect(dialSignal).toBeInstanceOf(AbortSignal);
  expect(dialSignal?.aborted).toBe(true);
  expect(toreDown).toBe(true);
  expect(mockState.handshakes).toHaveLength(0);
});

// --- the refusals -----------------------------------------------------------

test("a webrtc run with no shared secret is refused, naming the rendezvous", async () => {
  // The zero-setup shape: `auth: null`. The refusal has to say why the channel
  // cannot work without a secret, not report the channel as unsupported.
  await expect(
    runProtocol({
      connection: webrtcConnection("inviter"),
      auth: null,
      prepared: minimalPrepared,
      output: path.join(tmpDir, "out.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(UsageError);
  expect(WEBRTC_RENDEZVOUS_SECRET_REQUIRED).toContain("shared secret");
  expect(WEBRTC_RENDEZVOUS_SECRET_REQUIRED).toContain("psilink invite");
  // Nothing was dialed: the resolution runs before the transport is touched.
  expect(mockState.dials).toHaveLength(0);
});

test("a webrtc connection with no role is refused before anything is dialed", async () => {
  const keyFilePath = path.join(tmpDir, "roleless.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  const { role: _dropped, ...roleless } = webrtcConnection("inviter");
  await expect(
    runProtocol({
      connection: roleless,
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "out.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(WEBRTC_ROLE_REQUIRED);
  expect(mockState.dials).toHaveLength(0);
});

test("a host the resolver admits but the authority parse refuses exits 64", async () => {
  // A host carrying its own port is free of every delimiter the resolver's shape
  // refusal names, so it reaches the rendezvous line, where the authority parse
  // -- which refuses a host contributing a port, because that silently drops the
  // configured one -- is what stops it. That raise sits inside the run rather
  // than at the boundary the refusals above are decided at, and it reaches the
  // caller as a usage error only because the run's catch rethrows unmodified: a
  // wrap would exit 69 and set an unattended supervisor retrying a locator that
  // cannot resolve on any attempt.
  const error = await runParty("inviter", "peers.example.org:9000").then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(UsageError);
  expect(exitCodeForError(error)).toBe(64);
  expect((error as Error).message).toBe(BROKER_ADDRESS_REFUSED);
  expect(mockState.dials).toHaveLength(0);
});

test("each refusal survives the display boundary whole", () => {
  // The remedy is the last sentence of every one of these, and the render
  // boundary truncates a link at DEFAULT_MAX_DISPLAY_LENGTH characters -- so a
  // message that grows past it loses exactly the part the operator acts on,
  // silently and only at the terminal.
  for (const message of [
    WEBRTC_RENDEZVOUS_SECRET_REQUIRED,
    WEBRTC_ROLE_REQUIRED,
    WEBRTC_URL_REFUSED,
    WEBRTC_URL_EXTRAS_REFUSED,
    ID_TAKEN_MESSAGE,
    WEBRTC_BROKER_HOST_REFUSED,
    WEBRTC_BROKER_PATH_REFUSED,
  ]) {
    expect(sanitizeErrorForDisplay(new UsageError(message))).not.toContain(
      DISPLAY_TRUNCATION_MARKER,
    );
  }
});

// --- the resolver -----------------------------------------------------------

test("an omitted server block resolves to the PeerJS defaults, over TLS", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
    },
    SECRET,
  );
  // Each default is the one a PeerJS client applies to the same omission, except
  // `secure`, which a browser takes from its page and the CLI cannot.
  expect(options.location).toEqual({
    host: "peers.example.org",
    port: 443,
    path: "/",
    key: "peerjs",
    secure: true,
  });
});

test("a plaintext broker resolves to the plaintext default port", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "127.0.0.1", secure: false },
      role: "acceptor",
    },
    SECRET,
  );
  expect(options.location.port).toBe(80);
  expect(options.location.secure).toBe(false);
});

test("port 0 is refused rather than dialed", () => {
  // The connection schema admits it as a legal port number; nothing listens on
  // it, so dialing would report a connect failure instead of the misconfiguration.
  expect(() =>
    webRtcDialFrom(
      {
        channel: "webrtc",
        server: { host: "peers.example.org", port: 0 },
        role: "inviter",
      },
      SECRET,
    ),
  ).toThrow(UsageError);
});

test("a server path that could move the signaling socket is refused", () => {
  // Measured against Node's URL parser and WebSocket: concatenated into the
  // address, `@attacker.example` makes the configured host the userinfo of the
  // partner's, so the socket is dialed at the partner's host while the config --
  // and the run's own "rendezvousing through the signaling server at ..." line --
  // still name the legitimate broker. The path is partner-supplied on the
  // primary route: an offline accept builds the connection from the invitation's
  // endpoint, whose schema bounds `path` only by length.
  for (const serverPath of [
    "@attacker.example",
    "peerjs",
    "",
    "/api?x=1",
    "/api#f",
    "/api\\x",
    "/api ",
  ]) {
    expect(() =>
      webRtcDialFrom(
        {
          channel: "webrtc",
          server: { host: "peers.example.org", path: serverPath },
          role: "inviter",
        },
        SECRET,
      ),
    ).toThrow(WEBRTC_BROKER_PATH_REFUSED);
  }
});

test("a server host that could move the signaling socket is refused", () => {
  for (const host of [
    "broker.example:443@attacker.example",
    "peers.example.org/x",
    "peers.example.org?x",
    "peers.example.org#f",
    "peers.example.org\\x",
    "peers example org",
  ]) {
    expect(() =>
      webRtcDialFrom(
        {
          channel: "webrtc",
          server: { host },
          role: "inviter",
        },
        SECRET,
      ),
    ).toThrow(WEBRTC_BROKER_HOST_REFUSED);
  }
});

test("a mounted broker path still resolves", () => {
  // The refusals above bound the shape without costing the field its purpose: a
  // deployment mounted under a sub-path is what `path` is for.
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org", path: "/psi/signal" },
      role: "inviter",
    },
    SECRET,
  );
  expect(options.location.path).toBe("/psi/signal");
});

test("an injected path fails the run before anything is dialed", async () => {
  const keyFilePath = path.join(tmpDir, "injected.key");
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  await expect(
    runProtocol({
      connection: {
        ...webrtcConnection("inviter"),
        server: {
          host: "peers.example.org",
          port: 9000,
          secure: false,
          path: "@attacker.example",
        },
      },
      auth: { sharedSecret: SECRET, keyFilePath },
      prepared: minimalPrepared,
      output: path.join(tmpDir, "injected.csv"),
      verbosity: -1,
      loggerName: "test",
    }),
  ).rejects.toThrow(UsageError);
  expect(mockState.dials).toHaveLength(0);
});

test("peer_timeout_ms bounds each of the transport's three waits", () => {
  // Its documented meaning is the total wait for the partner, which on this
  // transport is three waits: the rendezvous before the channel exists, the
  // channel opening once both descriptions are exchanged, and the parked
  // receive after. The reference doc's peer_timeout_ms row states that a set
  // value replaces all three, and this is what holds it to that.
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      options: { peerTimeoutMs: 90_000 },
    },
    SECRET,
  );
  expect(options.inactivityTimeoutMs).toBe(90_000);
  expect(options.rendezvousTimeoutMs).toBe(90_000);
  expect(options.channelOpenTimeoutMs).toBe(90_000);
});

test("an unset peer_timeout_ms leaves all three transport defaults in place", () => {
  const { options } = webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
    },
    SECRET,
  );
  expect(options.inactivityTimeoutMs).toBeUndefined();
  expect(options.rendezvousTimeoutMs).toBeUndefined();
  expect(options.channelOpenTimeoutMs).toBeUndefined();
});
