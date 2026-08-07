import type { Socket } from "node:net";

import { expect, test } from "vitest";
import type Ssh2SftpClient from "ssh2-sftp-client";
import type { SFTPWrapper } from "ssh2";

import { createRawSftpClient } from "../rawSftpClient";
import {
  type InProcessSftpServer,
  selectedBackend,
  startInProcessSftpServer,
} from "../sftpServer";

// Premises about the pinned ssh2 / ssh2-sftp-client stack that psilink's own code
// is built on, driven at the layer each is asserted about: the raw
// ssh2-sftp-client, not the adapter. They are here so a bump of either package
// fails red at the premise that moved, and so the failure names which one --
// where an adapter-level test would report the same break as a timeout.
//
// Which premises are checks and which stay re-verify-on-upgrade prose, and why,
// is recorded in docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP Stack").
//
// Only the in-process backend can be made to stall a handshake or drop a session,
// so these run there and stand up their own server to reach the session controls
// -- the shared globalSetup server hands the workers only its connection details.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

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
const TEST_TIMEOUT_MS = 60_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The two internals every case here reaches: the session property whose
// assignment discipline the captured-wrapper premise is about, and the socket
// beneath the ssh2 Client that the abandoning teardown destroys.
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
// Both waits are load-bearing. The server's count is what says the stall has the
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

      // This is the premise that keeps the abandoning teardown reaching the
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
  "a destroy-driven mid-handshake rejection carries a peer close's own error code",
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
      // settles a dial on its own. This is the premise behind the rule that the
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
