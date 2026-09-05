import net from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { expect, test } from "vitest";
import type Ssh2SftpClient from "ssh2-sftp-client";
import type { SFTPWrapper } from "ssh2";

import {
  isPreIdentificationDialFailure,
  peerProbeTargetFromConnectOptions,
} from "../../src/connection/sftpPeerIdentification";
import { createRawSftpClient } from "../rawSftpClient";
import {
  type InProcessSftpServer,
  MAX_DELIVERED_SFTP_PAYLOAD_BYTES,
  READDIR_BATCH_BUDGET_BYTES,
  startInProcessSftpServer,
} from "../sftpServer";
import { inProcessOnly } from "../sftpBackendGate";

// Assumptions about the pinned ssh2 / ssh2-sftp-client stack that psilink's own
// code is built on, driven at the layer each is asserted about: the raw
// ssh2-sftp-client, not the adapter. A bump of either package fails red at the
// assumption that moved, naming which one, where an adapter-level test would
// report the same break as a timeout. Which assumptions are checks and which
// stay re-verify-on-upgrade prose, and why: docs/spec/DEPENDENCY_PINS.md
// ("Upgrading the SFTP Stack"). Only the in-process backend can be made to
// stall a handshake or drop a session, so these run there with their own
// server; the shared globalSetup server hands workers only connection details.

// Far past every assertion window below, so a dial parked against the stalling
// server settles only when a case settles it, never on its own deadline.
const READY_TIMEOUT_MS = 30_000;
// The mid-handshake end() was measured at 1 ms. This is the ceiling separating
// "short-circuited" from "waited on the transport".
const END_SETTLE_CEILING_MS = 1_000;
// How long a dial is watched for a settlement that must not come.
const PARKED_GRACE_MS = 250;
// The destroy-driven rejection was measured at 1-5 ms. A ceiling two orders of
// magnitude above it also excludes ssh2-sftp-client's own retry, which re-dials
// on a fresh socket about a second later.
const DESTROY_SETTLE_CEILING_MS = 500;
// The wait behind "an end() ahead of the destroy DISABLES it". It has to be
// clearly past the window in which the destroy on its own settles the dial, and
// that window is DESTROY_SETTLE_CEILING_MS above; this doubles it and is the
// whole cost of that case.
const DISABLED_DESTROY_WAIT_MS = 1_000;
// A superseded wrapper was measured producing no callback at 1500 ms, against
// 0-2 ms for the fresh one answering the identical call.
const STALE_WRAPPER_SILENCE_MS = 1_500;
const FRESH_WRAPPER_ANSWER_CEILING_MS = 1_000;
// A NAME reply at the widths below crosses loopback in single-digit
// milliseconds; the ceiling is orders above that. A reply the client refuses
// settles just as fast, so the longer window is spent only where the assumption
// has moved and the reply went nowhere at all.
const NAME_REPLY_ANSWER_CEILING_MS = 1_000;
const NAME_REPLY_SILENCE_MS = 1_500;
// Wide enough that the fixed framing measured against it is a small part of the
// reply, narrow enough to be nowhere near any bound.
const CALIBRATION_FILENAME_BYTES = 1_024;
const TEST_TIMEOUT_MS = 60_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The two internals every case here reaches: the session property whose
// assignment discipline the captured-wrapper assumption is about, and the
// socket beneath the ssh2 Client that the abandoning teardown destroys.
interface RawClientInternals {
  sftp?: SFTPWrapper;
  client?: { _sock?: Socket };
}

function internalsOf(client: Ssh2SftpClient): RawClientInternals {
  return client as unknown as RawClientInternals;
}

function dialOptions(srv: InProcessSftpServer): Ssh2SftpClient.ConnectOptions {
  const { host, port, usera } = srv.handle;
  return {
    host,
    port,
    username: usera.username,
    password: usera.password,
    readyTimeout: READY_TIMEOUT_MS,
    // ssh2-sftp-client's own dial retry, held to a single attempt: a re-dial
    // would mint a fresh socket and park again, so a case measuring what one
    // attempt does with the socket beneath it would never see its outcome.
    retries: 1,
  };
}

type DialOutcome = "pending" | "resolved" | "rejected";

interface TrackedDial {
  outcome(): DialOutcome;
  rejection(): unknown;
  settledAfterMs(): number | undefined;
  /** Resolves once the dial settles either way; never rejects. */
  settlement: Promise<void>;
}

function trackDial(dial: Promise<unknown>): TrackedDial {
  const started = Date.now();
  let outcome: DialOutcome = "pending";
  let rejection: unknown;
  let settledAfterMs: number | undefined;
  const settlement = dial.then(
    () => {
      outcome = "resolved";
      settledAfterMs = Date.now() - started;
    },
    (err: unknown) => {
      outcome = "rejected";
      rejection = err;
      settledAfterMs = Date.now() - started;
    },
  );
  return {
    outcome: () => outcome,
    rejection: () => rejection,
    settledAfterMs: () => settledAfterMs,
    settlement,
  };
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 30_000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("waitFor: condition not met within timeout");
}

// Park a dial against a server that answers the SSH identification string and
// then writes nothing more, and hand back the socket beneath it. Every
// stalled-handshake case starts here.
//
// Both waits are required. The server's count is what says the stall has the
// connection: the client's socket exists from the moment it starts connecting,
// so acting on the socket alone can act on a handshake that then completes
// normally.
async function parkDialMidHandshake(
  srv: InProcessSftpServer,
  client: Ssh2SftpClient,
): Promise<{ dial: TrackedDial; socket: Socket }> {
  const controls = srv.sessionControls;
  const stalledBefore = controls.stalledConnectionCount();
  controls.stallHandshakeOnConnect = true;
  const dial = trackDial(client.connect(dialOptions(srv)));
  const internals = internalsOf(client);
  await waitFor(() => internals.client?._sock !== undefined);
  await waitFor(() => controls.stalledConnectionCount() > stalledBefore);
  const socket = internals.client?._sock as Socket;
  expect(dial.outcome()).toBe("pending");
  return { dial, socket };
}

// Issue the cheapest real SFTP round-trip on a wrapper and report what came
// back within the bound. A synchronous throw is reported as itself rather than
// failing the case, so a version that started refusing the call outright names
// that instead of reading as silence.
async function realpathOutcome(
  wrapper: SFTPWrapper,
  withinMs: number,
): Promise<"answered" | "errored" | "threw" | "no callback"> {
  let settled: "answered" | "errored" | undefined;
  try {
    wrapper.realpath(".", (err) => {
      settled = err ? "errored" : "answered";
    });
  } catch {
    return "threw";
  }
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (settled !== undefined) return settled;
    await delay(10);
  }
  return "no callback";
}

// The wrapper beneath a connected raw client together with a directory handle
// open on the served root: what a case needs to issue one READDIR of its own and
// read what the server's reply to it did.
interface ServedRoot {
  wrapper: SFTPWrapper;
  handle: Buffer;
  /**
   * Fatal SFTP errors the client raised on this session, in arrival order. The
   * listener also keeps one from reaching an EventEmitter with nothing attached
   * and taking the worker down with it.
   */
  fatals: Error[];
}

async function openServedRoot(
  srv: InProcessSftpServer,
  client: Ssh2SftpClient,
): Promise<ServedRoot> {
  const wrapper = internalsOf(client).sftp;
  if (wrapper === undefined)
    throw new Error("the connected client exposed no SFTPWrapper");
  const fatals: Error[] = [];
  wrapper.on("error", (err: Error) => fatals.push(err));
  const handle = await new Promise<Buffer>((resolve, reject) => {
    wrapper.opendir(srv.handle.remoteRoot, (err, opened) => {
      if (err) reject(err);
      else resolve(opened);
    });
  });
  return { wrapper, handle, fatals };
}

interface NameReplyOutcome {
  /** What the READDIR that drew the reply did. */
  outcome: "delivered" | "errored" | "no reply";
  /** Payload length the server declared for the reply; -1 if it wrote none. */
  declaredPayloadBytes: number;
  /** Filename bytes the entry that arrived held; -1 when none did. */
  deliveredFilenameBytes: number;
}

// Arm the server to answer one READDIR with a single-entry NAME reply of the
// given filename width, issue that READDIR, and report what the client made of
// it inside the bound -- alongside the payload width the server's own encoder
// declared for it, so the case reads a measured width rather than an intended
// one. Session-fatal errors land in the ServedRoot rather than settling the
// request: what the REQUEST did and what the SESSION did are separate readings.
async function nameReplyOutcome(
  srv: InProcessSftpServer,
  root: ServedRoot,
  filenameBytes: number,
  withinMs: number,
): Promise<NameReplyOutcome> {
  let settled: "delivered" | "errored" | undefined;
  let deliveredFilenameBytes = -1;
  srv.inject.lastNameReplyPayloadBytes = undefined;
  srv.inject.nameReplyFilenameBytesOnNextReaddir = filenameBytes;
  root.wrapper.readdir(root.handle, (err, list) => {
    if (settled !== undefined) return;
    settled = err ? "errored" : "delivered";
    if (!err)
      deliveredFilenameBytes = Buffer.byteLength(list[0]?.filename ?? "");
  });
  const deadline = Date.now() + withinMs;
  while (settled === undefined && Date.now() < deadline) await delay(10);
  return {
    outcome: settled ?? "no reply",
    declaredPayloadBytes: srv.inject.lastNameReplyPayloadBytes ?? -1,
    deliveredFilenameBytes,
  };
}

// ssh2 frames a single-entry NAME reply with a fixed overhead around the
// filename. Measured off a narrow reply rather than predicted, so a case can
// place a reply at a width the stack itself decides is that width.
async function nameReplyOverheadBytes(
  srv: InProcessSftpServer,
  root: ServedRoot,
): Promise<number> {
  const probe = await nameReplyOutcome(
    srv,
    root,
    CALIBRATION_FILENAME_BYTES,
    NAME_REPLY_ANSWER_CEILING_MS,
  );
  expect({
    outcome: probe.outcome,
    filenameBytes: probe.deliveredFilenameBytes,
  }).toEqual({
    outcome: "delivered",
    filenameBytes: CALIBRATION_FILENAME_BYTES,
  });
  return probe.declaredPayloadBytes - CALIBRATION_FILENAME_BYTES;
}

// The comparable shape of a dial rejection: what a caller could match on to tell
// two rejections apart.
function rejectionShape(err: unknown): {
  name: string;
  code: unknown;
  message: string;
} {
  const error = err as { name?: string; code?: unknown; message?: string };
  return {
    name: error?.name ?? "(not an Error)",
    code: error?.code,
    message: error?.message ?? "",
  };
}

inProcessOnly(
  "ssh2-sftp-client's end() driven mid-handshake closes nothing",
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    try {
      const { dial, socket } = await parkDialMidHandshake(srv, client);

      const started = Date.now();
      await client.end();
      const endMs = Date.now() - started;
      await delay(PARKED_GRACE_MS);

      // This is the assumption that keeps the abandoning teardown reaching the
      // destroy and never end(): the call settles at once and leaves the
      // transport and the dial exactly as it found them.
      expect({
        settledPromptly: endMs < END_SETTLE_CEILING_MS,
        destroyed: socket.destroyed,
        writable: socket.writable,
        dial: dial.outcome(),
      }).toEqual({
        settledPromptly: true,
        destroyed: false,
        writable: true,
        dial: "pending",
      });

      // The socket is destroyed for teardown rather than left to its readyTimeout:
      // it is a ref'd handle, and this case has just measured that nothing else
      // here closes it. Whether the dial settles on that destroy is the
      // disabled-destroy case's subject, so nothing is asserted about it.
      socket.destroy();
      await Promise.race([dial.settlement, delay(DESTROY_SETTLE_CEILING_MS)]);
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "destroying the socket beneath a mid-handshake dial settles that dial",
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    try {
      const { dial, socket } = await parkDialMidHandshake(srv, client);

      socket.destroy();
      // Synchronously on return, which is what lets the teardown treat the
      // destroy as done rather than awaiting a close event of its own.
      expect(socket.destroyed).toBe(true);
      await Promise.race([dial.settlement, delay(DESTROY_SETTLE_CEILING_MS)]);

      expect({
        outcome: dial.outcome(),
        withinCeiling:
          (dial.settledAfterMs() ?? Infinity) < DESTROY_SETTLE_CEILING_MS,
      }).toEqual({ outcome: "rejected", withinCeiling: true });
      // The text the spec records for it. Pinned apart from the comparison
      // against a peer close below, so a bump that merely reworded the rejection
      // is told from one that changed how it compares.
      expect(rejectionShape(dial.rejection())).toEqual({
        name: "Error",
        code: "ERR_GENERIC_CLIENT",
        message: "getConnection: Unexpected close event",
      });
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a destroy-driven mid-handshake rejection holds a peer close's own error code",
  async () => {
    const srv = await startInProcessSftpServer();
    const destroyer = createRawSftpClient();
    const closed = createRawSftpClient();
    try {
      const local = await parkDialMidHandshake(srv, destroyer);
      local.socket.destroy();
      await Promise.race([
        local.dial.settlement,
        delay(DESTROY_SETTLE_CEILING_MS),
      ]);

      // The other side of the comparison, produced at the same handshake stage:
      // the server closes the connection it is holding stalled, so this dial ends
      // on a peer close rather than on anything this process did.
      const peer = await parkDialMidHandshake(srv, closed);
      srv.sessionControls.closeStalledConnections();
      await Promise.race([
        peer.dial.settlement,
        delay(DESTROY_SETTLE_CEILING_MS),
      ]);

      expect({
        local: local.dial.outcome(),
        peer: peer.dial.outcome(),
      }).toEqual({ local: "rejected", peer: "rejected" });
      const localShape = rejectionShape(local.dial.rejection());
      const peerShape = rejectionShape(peer.dial.rejection());
      // The machine-readable half is the same error on both, so nothing branching
      // on class or code can attribute the teardown's own destroy to the partner
      // -- which is why that destroy is not reported as a partner-side dial
      // failure. A version that gave the destroy path a code of its own fails
      // here.
      expect({ name: localShape.name, code: localShape.code }).toEqual({
        name: peerShape.name,
        code: peerShape.code,
      });
      // What DOES differ is the message, and only in the transport event it
      // names: the peer's close arrives as an end, a destroyed socket as a close.
      // Both are pinned, because a caller matching either fragment is matching a
      // cause it cannot read from it.
      expect({ local: localShape.message, peer: peerShape.message }).toEqual({
        local: "getConnection: Unexpected close event",
        peer: "getConnection: Unexpected end event",
      });
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "an end() driven mid-handshake ahead of the destroy disables the destroy",
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    try {
      const { dial, socket } = await parkDialMidHandshake(srv, client);

      await client.end();
      socket.destroy();
      await delay(DISABLED_DESTROY_WAIT_MS);

      // The destroy landed and settled nothing, well past the window in which it
      // settles a dial on its own. This is the assumption behind the rule that the
      // abandoning teardown must not create an end(): one ahead of the destroy
      // costs it the only thing it was for.
      expect({
        destroyed: socket.destroyed,
        dial: dial.outcome(),
      }).toEqual({ destroyed: true, dial: "pending" });
    } finally {
      srv.sessionControls.stopStallingHandshakes();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a superseded SFTPWrapper neither transmits nor calls back",
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    const internals = internalsOf(client);
    try {
      await client.connect(dialOptions(srv));
      const superseded = internals.sftp;
      expect(superseded).toBeDefined();

      // A clean server-side drop, then the re-dial that assigns a fresh wrapper
      // over the captured one -- the shape a mid-exchange recovery reaches.
      srv.sessionControls.dropActiveAfterMs(1);
      await waitFor(() => internals.sftp === undefined);
      await client.connect(dialOptions(srv));
      const fresh = internals.sftp;
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(superseded);

      const [supersededAnswer, freshAnswer] = await Promise.all([
        realpathOutcome(superseded as SFTPWrapper, STALE_WRAPPER_SILENCE_MS),
        realpathOutcome(fresh as SFTPWrapper, FRESH_WRAPPER_ANSWER_CEILING_MS),
      ]);

      // What keeps a capture that DID go stale inert rather than misrouted: the
      // request neither reaches the fresh session nor comes back, so the holding
      // operation rides its own deadline instead of reading another session's
      // reply.
      expect({ superseded: supersededAnswer, fresh: freshAnswer }).toEqual({
        superseded: "no callback",
        fresh: "answered",
      });
    } finally {
      await client.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `the pinned stack's NAME reply holds ${READDIR_BATCH_BUDGET_BYTES} payload bytes`,
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    try {
      await client.connect(dialOptions(srv));
      const root = await openServedRoot(srv, client);
      const overhead = await nameReplyOverheadBytes(srv, root);

      const reply = await nameReplyOutcome(
        srv,
        root,
        READDIR_BATCH_BUDGET_BYTES - overhead,
        NAME_REPLY_ANSWER_CEILING_MS,
      );

      // The width the test backend packs every listing batch to, and the reason
      // a directory wider than one packet is served over several round trips at
      // all. This is the assumption a suite driving a wide listing rests on,
      // where a stack that stopped delivering this width would be treated as
      // that suite's own batching having broken. The whole reply is accounted
      // for -- the entry arrives with every byte the server put in it -- so a
      // truncated delivery is not treated as a delivery.
      expect({
        outcome: reply.outcome,
        declaredPayloadBytes: reply.declaredPayloadBytes,
        deliveredFilenameBytes: reply.deliveredFilenameBytes,
      }).toEqual({
        outcome: "delivered",
        declaredPayloadBytes: READDIR_BATCH_BUDGET_BYTES,
        deliveredFilenameBytes: READDIR_BATCH_BUDGET_BYTES - overhead,
      });
      expect(root.fatals).toEqual([]);
    } finally {
      await client.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `the pinned stack's NAME reply wall stands at ${MAX_DELIVERED_SFTP_PAYLOAD_BYTES} payload bytes`,
  async () => {
    const srv = await startInProcessSftpServer();
    const client = createRawSftpClient();
    try {
      await client.connect(dialOptions(srv));
      const root = await openServedRoot(srv, client);
      const overhead = await nameReplyOverheadBytes(srv, root);

      const atWall = await nameReplyOutcome(
        srv,
        root,
        MAX_DELIVERED_SFTP_PAYLOAD_BYTES - overhead,
        NAME_REPLY_ANSWER_CEILING_MS,
      );
      const pastWall = await nameReplyOutcome(
        srv,
        root,
        MAX_DELIVERED_SFTP_PAYLOAD_BYTES + 1 - overhead,
        NAME_REPLY_SILENCE_MS,
      );

      // Where the wall the batch budget is derived from stands, driven from both
      // sides at the byte: the server writes each reply through its own encoder,
      // and the width it declared for each is what the widths below are read
      // from. One byte past the wall the reply is refused at the client, not
      // delivered and not narrowed, and the server that wrote it is told nothing.
      // The budget is half of this, which is the margin that absorbs a wall that
      // moves a little; one that moved below the budget fails the case above as
      // well, and the two together say whether the batching still has room.
      expect({
        atWall: {
          outcome: atWall.outcome,
          declaredPayloadBytes: atWall.declaredPayloadBytes,
          deliveredFilenameBytes: atWall.deliveredFilenameBytes,
        },
        pastWall: {
          outcome: pastWall.outcome,
          declaredPayloadBytes: pastWall.declaredPayloadBytes,
        },
      }).toEqual({
        atWall: {
          outcome: "delivered",
          declaredPayloadBytes: MAX_DELIVERED_SFTP_PAYLOAD_BYTES,
          deliveredFilenameBytes: MAX_DELIVERED_SFTP_PAYLOAD_BYTES - overhead,
        },
        pastWall: {
          outcome: "errored",
          declaredPayloadBytes: MAX_DELIVERED_SFTP_PAYLOAD_BYTES + 1,
        },
      });
      // The refusal is fatal to the SFTP session rather than local to the
      // request, and the client names the width it is holding to -- so the wall
      // the backend budgets against is the client's own number, not one this
      // suite inferred from where delivery stopped.
      expect(root.fatals).toHaveLength(1);
      expect(root.fatals[0].message).toContain(
        String(MAX_DELIVERED_SFTP_PAYLOAD_BYTES),
      );
    } finally {
      await client.end().catch(() => {});
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// What a proxy or gateway answering the SFTP port sends instead of an SSH
// identification string.
const HTTP_ERROR_PAGE =
  "HTTP/1.0 403 Forbidden\r\n" +
  "Content-Type: text/html\r\n" +
  "\r\n" +
  "<html><head><title>Forbidden</title></head></html>\r\n";

interface BarePeer {
  host: string;
  port: number;
  /**
   * Destroy the accepted connection, then close the listener. The destroy is
   * what lets the close settle: after this stack has rejected a dial the
   * connection is still open on this side, and `close()` waits on it (measured
   * -- it did not settle within 1.5 s until the accepted socket was gone).
   */
  stop(): Promise<void>;
}

// A bare TCP listener answering one connection the way `answer` says, on a port
// the kernel picks: the peer shape no SFTP backend can be made to take, one that
// is not an SSH server at all.
function barePeer(answer: (socket: Socket) => void): Promise<BarePeer> {
  return new Promise((resolve) => {
    const accepted: Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      // A reset peer's own socket errors on the write side; nothing here reads
      // it, and an unhandled 'error' would fail the file.
      socket.on("error", () => {});
      answer(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        host: "127.0.0.1",
        port,
        stop: () =>
          new Promise<void>((closed) => {
            for (const socket of accepted) socket.destroy();
            server.close(() => closed());
          }),
      });
    });
  });
}

type DialGateOutcome = "gated" | "rejected past the gate" | "connected";

// Dial such a peer with the pinned client and report whether the rejection it
// raises still reaches the diagnosis's gate.
async function preIdentificationDialOutcome(
  answer: (socket: Socket) => void,
): Promise<DialGateOutcome> {
  const peer = await barePeer(answer);
  const client = createRawSftpClient();
  try {
    await client.connect({
      host: peer.host,
      port: peer.port,
      // Inert: none of these dials reaches userauth.
      username: "unused",
      readyTimeout: READY_TIMEOUT_MS,
      // One attempt, as dialOptions above holds itself to, so the verdict below
      // reads a single rejection rather than the last of a retried series.
      retries: 1,
    });
    return "connected";
  } catch (err) {
    return isPreIdentificationDialFailure(err)
      ? "gated"
      : "rejected past the gate";
  } finally {
    await peer.stop();
  }
}

// The assumption arming the host-key probe's non-SSH-answer diagnosis
// (`apps/cli/src/connection/sftpPeerIdentification.ts`): the rejection this
// stack raises for a dial that ended before an SSH identification string still
// holds wording the diagnosis matches. Driven against bare listeners rather
// than the test SFTP server, an SSH server being the one thing these peers must
// not be, so this case is not backend-scoped like the ones above.
test(
  "a peer that never identifies itself is rejected in wording the diagnosis gates on",
  async () => {
    expect({
      httpErrorPage: await preIdentificationDialOutcome((socket) => {
        socket.write(HTTP_ERROR_PAGE);
        socket.end();
      }),
      closedHavingSentNothing: await preIdentificationDialOutcome((socket) => {
        socket.end();
      }),
      // A reset rather than a close, because that is what the ECONNRESET
      // fragment is for -- and driven with resetAndDestroy rather than destroy,
      // which at accept with nothing left to read arrives as an ordinary close
      // (measured) and would leave that fragment unexercised.
      resetAtAccept: await preIdentificationDialOutcome((socket) => {
        socket.resetAndDestroy();
      }),
    }).toEqual({
      httpErrorPage: "gated",
      closedHavingSentNothing: "gated",
      resetAtAccept: "gated",
    });
  },
  TEST_TIMEOUT_MS,
);

const LOOPBACK_HOST = "127.0.0.1";

// The endpoint a PORTLESS dial of the pinned client actually used, read off the
// address the stack itself names in its refusal -- the one place it reports
// where it went. Undefined when the dial failed some other way, which here means
// something is answering that port: such a rejection names no address, and
// re-deriving one would be re-deriving the assumption under test.
async function portlessDialTarget(): Promise<
  { host: string; port: number } | undefined
> {
  const client = createRawSftpClient();
  try {
    await client.connect({
      host: LOOPBACK_HOST,
      // No `port`: the case under test, and what core hands ssh2 for a config
      // that sets none.
      username: "unused",
      readyTimeout: READY_TIMEOUT_MS,
      retries: 1,
    });
    return undefined;
  } catch (err) {
    const refused = /ECONNREFUSED (\S+):(\d+)/.exec(
      (err as { message?: string }).message ?? "",
    );
    return refused ? { host: refused[1], port: Number(refused[2]) } : undefined;
  } finally {
    await client.end().catch(() => {});
  }
}

// The endpoint assumption beside the wording one: the diagnosis opens a connection
// of its own, so it has to reach the endpoint the failed dial reached, the
// default-port case included -- a read of a different port would report about a
// peer the dial never spoke to. The default is not asserted as a number here; it
// is whatever the pinned stack dialed, and the diagnosis's resolved target is
// held to that.
test(
  "the diagnosis resolves portless connect options to the endpoint the pinned stack dialed",
  async (ctx) => {
    const dialed = await portlessDialTarget();
    if (dialed === undefined)
      ctx.skip(
        `a portless dial of ${LOOPBACK_HOST} was not refused, so the stack ` +
          `named no address to read its default port from`,
      );
    expect(peerProbeTargetFromConnectOptions({ host: LOOPBACK_HOST })).toEqual(
      dialed,
    );
  },
  TEST_TIMEOUT_MS,
);
