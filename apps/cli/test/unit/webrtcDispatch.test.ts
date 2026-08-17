import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";

import type { MessageConnection, PreparedExchange } from "@psilink/core";

/**
 * `runProtocol`'s webrtc dispatch: the branch that runs the exchange over a data
 * channel instead of a shared folder.
 *
 * The wire below it is driven for real elsewhere -- two werift peers through the
 * vendored broker in test/integration/webrtcTransport.test.ts. What is only
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
  /** What each party asked the key exchange for, by handshake role. */
  handshakes: [] as Array<{ role: string; requestEncryption: boolean }>,
  /** The connection each party's runExchange was handed. */
  exchangeConnections: [] as Array<unknown>,
}));

vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Keep the key exchange real: the role mapping is only meaningful if a genuine
// initiator/responder handshake completes over it. Silence the logger, and stub
// the PSI exchange, which would otherwise need the WASM stack and a dataset.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: (_name: string) => ({
      info: () => {},
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
        mockState.handshakes.push({ role, requestEncryption });
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
      return { associationTable: [[], []], partnerPayload: {} };
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
const { WEBRTC_URL_REFUSED } = await import("../../src/connectionFromUrl");
const { ID_TAKEN_MESSAGE } =
  await import("../../src/connection/webrtc/brokerClient");
const { saveKeyFile } = await import("../../src/keyFile");
const {
  DISPLAY_TRUNCATION_MARKER,
  UsageError,
  generateSharedSecret,
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

const minimalPrepared = {} as unknown as PreparedExchange;
const SECRET = generateSharedSecret();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-webrtc-dispatch-"));
  pair = linkedPair();
  mockState.dials.length = 0;
  mockState.handshakes.length = 0;
  mockState.exchangeConnections.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function webrtcConnection(role: "inviter" | "acceptor") {
  return {
    channel: "webrtc" as const,
    server: { host: "peers.example.org", port: 9000, secure: false },
    role,
    stun: ["stun:stun.example.org:3478"],
  };
}

/** Run one party end to end over the linked pair. */
function runParty(role: "inviter" | "acceptor"): Promise<unknown> {
  const keyFilePath = path.join(tmpDir, `${role}.key`);
  saveKeyFile(keyFilePath, { sharedSecret: SECRET });
  return runProtocol(
    webrtcConnection(role),
    { sharedSecret: SECRET, keyFilePath },
    minimalPrepared,
    path.join(tmpDir, `${role}.csv`),
    -1,
    "test",
  );
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
    await runProtocol(
      webrtcConnection("inviter"),
      { sharedSecret: SECRET, keyFilePath },
      minimalPrepared,
      path.join(tmpDir, "signal.csv"),
      -1,
      "test",
    );
  } finally {
    exit.mockRestore();
  }
  expect(closed).toBeGreaterThan(0);
  // And no handshake was attempted over it.
  expect(mockState.handshakes).toHaveLength(0);
});

// --- the refusals -----------------------------------------------------------

test("a webrtc run with no shared secret is refused, naming the rendezvous", async () => {
  // The zero-setup shape: `auth: null`. The refusal has to say why the channel
  // cannot work without a secret, not report the channel as unsupported.
  await expect(
    runProtocol(
      webrtcConnection("inviter"),
      null,
      minimalPrepared,
      path.join(tmpDir, "out.csv"),
      -1,
      "test",
    ),
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
    runProtocol(
      roleless,
      { sharedSecret: SECRET, keyFilePath },
      minimalPrepared,
      path.join(tmpDir, "out.csv"),
      -1,
      "test",
    ),
  ).rejects.toThrow(WEBRTC_ROLE_REQUIRED);
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
    ID_TAKEN_MESSAGE,
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

test("peer_timeout_ms bounds the rendezvous as well as the parked receive", () => {
  // Its documented meaning is the total wait for the partner, which on a live
  // channel is two waits: before the channel exists, and after.
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
});

test("an unset peer_timeout_ms leaves both transport defaults in place", () => {
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
});
