import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import {
  FileSyncConnection,
  TransportOperationStalledError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend, startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";

// A partner-side drop tears every operation the adapter has on the wire, not just
// the one whose recovery re-dial runs. The adapter issues concurrent operations of
// its own -- a `send()` resuming from the protocol continuation runs alongside the
// poll cycle, and core's cleanup and rendezvous sweeps fan a delete out with
// `Promise.all`/`Promise.allSettled` -- so a single cut routinely lands on several.
// The cases here drive that partner for real and hold the OTHER operations to
// settling: on their own tear rather than on the per-operation liveness deadline,
// with their own correct results where the recovery re-issues them.
//
// Which operation enters recovery first is a property of the operation KIND rather
// than of issue order, because the two routes are torn a full event apart: a
// high-level ssh2-sftp-client operation (`get`) is settled from the ssh2 Client's
// 'end', a raw-wrapper one (`list`) only from its 'close'. Both issue orders are
// driven anyway, which is what makes that a measured claim rather than an
// assumption.
//
// Only the in-process backend can be told to cut or hold a session this way (a
// native sshd cannot; see test/sftpServer/types.ts), so these run there and stand
// up their own server -- the drop counter is server-wide, so a shared server would
// let a sibling file's traffic move the cut. The single-operation tear is
// inflightDropRecovery.test.ts, the socket-state census over the dials this path
// issues is dialDeferral.test.ts, and the withheld-close partner that leaves the
// session property SET is heldSessionWithheldClose.test.ts; the party scaffolding
// below is deliberately this file's own, as dialDeferral's is, because each file
// needs a different slice of the session controls.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

const TEST_TIMEOUT_MS = 120_000;

// The per-operation liveness deadline, lowered through the adapter's @internal
// test seam. No case here expects an operation to ride it -- riding it is the
// failure these assert against -- so it is lowered purely so a regression fails in
// seconds rather than spending the production minute per operation.
const STALL_DEADLINE_MS = 3_000;

// Large enough that the cut lands deep inside the transfer rather than at its
// edges: ssh2-sftp-client reads in 32 KiB chunks, so this is a few hundred READs.
const TRANSFER_BYTES = 8 * 1024 * 1024;

// The read cap the transport always passes; above the transfer, so the cap itself
// is never what ends a read here.
const READ_CAP_BYTES = 64 * 1024 * 1024;

// The listing that has to still be on the wire when the transfer is cut. Served
// one name per READDIR round trip (`readdirBatchSize = 1`), so the listing spans
// hundreds of opcodes instead of completing in a single batch -- without both the
// entry count and the batch cap the `list` finishes before the `get` has issued its
// first READ and the pair is never concurrent at all.
const LISTING_ENTRIES = 200;

// Files for the fan-out cases. Both shapes core actually produces are a fan of
// per-file deletes issued in one turn: the rendezvous orphan sweep's
// `Promise.allSettled` over `delete`, and the connection cleanup's `Promise.all`
// over the never-reject `safeDelete`.
const FAN_OUT_FILES = 40;

// How a dial the adapter issued ended. A dial failed by a stale lifecycle event
// leaves the handshake it started running unowned at the server, so a case that
// recovers cleanly must show none.
interface DialOutcome {
  settled: "resolved" | "rejected";
  error?: string;
}

interface DialableClient {
  connect: (options: Record<string, unknown>) => Promise<unknown>;
}

// Wrap the ssh2-sftp-client connect() the adapter calls, not the adapter's own:
// the dialing-retry loop inside it dials once per attempt, and a dial failed by a
// stale event is exactly what that loop hides from the adapter's callers.
function recordDials(adapter: SSH2SFTPClientAdapter): DialOutcome[] {
  const dials: DialOutcome[] = [];
  const client = (adapter as unknown as { client: DialableClient }).client;
  const connect = client.connect.bind(client);
  client.connect = async (options: Record<string, unknown>) => {
    const dial: DialOutcome = { settled: "resolved" };
    dials.push(dial);
    try {
      return await connect(options);
    } catch (error: unknown) {
      dial.settled = "rejected";
      dial.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return dials;
}

interface Party {
  srv: InProcessSftpServer;
  adapter: SSH2SFTPClientAdapter;
  conn: FileSyncConnection;
  dials: DialOutcome[];
  remote: string;
  localDir: string;
  stop: () => Promise<void>;
}

// One connected party on its own server, in its own rendezvous directory. The
// party drives the adapter directly rather than through a poll loop, so the
// server's op counter -- which is server-wide -- counts only this test's
// operations and a cut lands where the case aimed it.
async function connectParty(options: {
  maxReconnectAttempts: number;
  stallDeadlineMs?: number;
  withholdCloseOnDisconnect?: boolean;
}): Promise<Party> {
  const srv = await startInProcessSftpServer();
  const localDir = await fsp.mkdtemp(
    path.join(srv.handle.backingDir, "concurrent-"),
  );
  const remote = `${srv.handle.remoteRoot}/${path.basename(localDir)}`;
  const adapter = new SSH2SFTPClientAdapter({
    ephemeralSessions: false,
    ...(options.stallDeadlineMs === undefined
      ? {}
      : { stallDeadlineMs: options.stallDeadlineMs }),
  });
  const dials = recordDials(adapter);
  const conn = new FileSyncConnection(adapter, {
    verbose: -1,
    pollingFrequency: 10,
  });
  conn.on("error", () => {});
  // Armed before the dial, because the control replaces the closers on every
  // socket the server accepts and this party's own connection is the one it has
  // to reach.
  if (options.withholdCloseOnDisconnect)
    srv.sessionControls.withholdCloseOnDisconnect = true;
  await conn.open({
    channel: "sftp",
    server: {
      host: srv.handle.host,
      port: srv.handle.port,
      ...serverAuth(srv.handle.usera),
      path: remote,
    },
    options: { maxReconnectAttempts: options.maxReconnectAttempts },
  });
  // From here on the record holds only the dials a case provoked; the party's own
  // first connect is setup, not a subject.
  dials.length = 0;
  return {
    srv,
    adapter,
    conn,
    dials,
    remote,
    localDir,
    stop: async () => {
      // Clear every standing cap and injection before the teardown dials and
      // closes: one left armed cuts or withholds from the teardown instead of the
      // call under test.
      srv.sessionControls.maxIdleMs = 0;
      srv.sessionControls.maxOps = 0;
      srv.sessionControls.maxLifetimeMs = 0;
      srv.sessionControls.dropActiveAfterOps(0);
      srv.sessionControls.stopWithholdingCloses();
      srv.inject.withholdOn = null;
      srv.inject.readdirBatchSize = 0;
      await conn.close().catch(() => {});
      await fsp.rm(localDir, { recursive: true, force: true });
      await srv.stop();
    },
  };
}

async function plantTransfer(party: Party): Promise<string> {
  await fsp.writeFile(
    path.join(party.localDir, "transfer.bin"),
    Buffer.alloc(TRANSFER_BYTES, 7),
  );
  return `${party.remote}/transfer.bin`;
}

async function plantListing(party: Party): Promise<string> {
  const dir = path.join(party.localDir, "listing");
  await fsp.mkdir(dir);
  for (let index = 0; index < LISTING_ENTRIES; index += 1)
    await fsp.writeFile(path.join(dir, `entry-${index}.txt`), "x");
  return `${party.remote}/listing`;
}

async function plantFanOut(party: Party): Promise<string[]> {
  const targets: string[] = [];
  for (let index = 0; index < FAN_OUT_FILES; index += 1) {
    const name = `victim-${index}.json`;
    await fsp.writeFile(path.join(party.localDir, name), "{}");
    targets.push(`${party.remote}/${name}`);
  }
  return targets;
}

// What a settled operation is asserted on. The rejection reason is carried as the
// constructor name plus the message rather than the error, so a case that fails
// reports which operation took which outcome instead of a bare boolean.
interface Settlement {
  status: "fulfilled" | "rejected";
  detail: string;
}

function describeSettlement(
  outcome: PromiseSettledResult<unknown>,
): Settlement {
  if (outcome.status === "fulfilled") {
    const value = outcome.value;
    return {
      status: "fulfilled",
      detail: Buffer.isBuffer(value)
        ? `Buffer(${value.length})`
        : Array.isArray(value)
          ? `Array(${value.length})`
          : String(value),
    };
  }
  const error: unknown = outcome.reason;
  return {
    status: "rejected",
    detail: `${
      error instanceof Error ? error.constructor.name : typeof error
    }: ${error instanceof Error ? error.message : String(error)}`,
  };
}

// The rejection an operation carries when nothing settled it and its own liveness
// bound expired instead, which is the outcome every case here asserts against:
// naming the type is what separates it from a tear the operation was settled by.
function stalled(outcome: PromiseSettledResult<unknown>): boolean {
  return (
    outcome.status === "rejected" &&
    outcome.reason instanceof TransportOperationStalledError
  );
}

for (const order of ["list-first", "get-first"] as const)
  inProcessOnly(
    `a list and a get on the wire together at a clean drop both complete, ` +
      `issued ${order}`,
    async () => {
      const party = await connectParty({
        maxReconnectAttempts: 4,
        stallDeadlineMs: STALL_DEADLINE_MS,
      });
      try {
        const remoteFile = await plantTransfer(party);
        const remoteDir = await plantListing(party);
        const controls = party.srv.sessionControls;
        party.srv.inject.readdirBatchSize = 1;
        controls.resetHandshakeCount();

        const [outcomes, logs] = await withCapturedLogs(
          async () => {
            // Deep enough into the pair that both are genuinely on the wire: the
            // listing has issued its OPENDIR and a run of READDIRs and the
            // transfer its OPEN and first READs.
            controls.dropActiveAfterOps(24);
            const startedAt = performance.now();
            const issue = {
              list: () => party.adapter.list(remoteDir),
              get: () =>
                party.adapter.get(remoteFile, { maxBytes: READ_CAP_BYTES }),
            };
            // Both are issued in one turn, so the drop lands on the pair rather
            // than on whichever happened to be left.
            const settled = await Promise.allSettled(
              order === "list-first"
                ? [issue.list(), issue.get()]
                : [issue.get(), issue.list()],
            );
            return {
              settled,
              elapsedMs: performance.now() - startedAt,
            };
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        const [list, get] =
          order === "list-first"
            ? [outcomes.settled[0], outcomes.settled[1]]
            : [outcomes.settled[1], outcomes.settled[0]];

        // Neither operation was left for its own deadline to settle: the tear
        // settled both, and the recovery re-issued both.
        expect(outcomes.settled.filter(stalled)).toEqual([]);
        expect(describeSettlement(list)).toEqual({
          status: "fulfilled",
          detail: `Array(${LISTING_ENTRIES})`,
        });
        expect(describeSettlement(get)).toEqual({
          status: "fulfilled",
          detail: `Buffer(${TRANSFER_BYTES})`,
        });

        // A ceiling, not a timing assertion: an operation that rode the liveness
        // deadline instead of its tear would sit above it whatever the machine,
        // and one that recovered sits an order of magnitude below.
        expect(outcomes.elapsedMs).toBeLessThan(2_000);

        // One cut, and every dial it cost was one the adapter kept: a dial a stale
        // lifecycle event failed would leave a session behind at the server.
        expect(controls.handshakeCount()).toBe(1);
        expect(
          party.dials.filter((dial) => dial.settled === "rejected"),
        ).toEqual([]);
        // The drop is reported to the operator as a survived drop, never as none.
        expect(
          logs.filter((entry) =>
            entry.message.includes(
              "dropped mid-exchange and was transparently",
            ),
          ).length,
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  "a delete fan-out torn by one clean drop settles every member on its result",
  async () => {
    // The rendezvous orphan sweep's shape: one turn's worth of per-file deletes
    // under Promise.allSettled, all on the wire when the cut lands. Every member
    // but the one whose recovery runs is a concurrent operation by construction.
    const party = await connectParty({
      maxReconnectAttempts: 6,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const targets = await plantFanOut(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const outcomes = await withCapturedLogs(
        async () => {
          // The cut lands on the first REMOVE of the fan, with the rest of the fan
          // already dispatched behind it.
          controls.dropActiveAfterOps(1);
          const startedAt = performance.now();
          const settled = await Promise.allSettled(
            targets.map((target) => party.adapter.delete(target)),
          );
          return { settled, elapsedMs: performance.now() - startedAt };
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(outcomes.settled.filter(stalled)).toEqual([]);
      expect(outcomes.settled.map(describeSettlement)).toEqual(
        targets.map(() => ({ status: "fulfilled", detail: "undefined" })),
      );
      // The deletes landed, rather than merely reporting they had.
      expect(
        (await fsp.readdir(party.localDir)).filter((name) =>
          name.startsWith("victim-"),
        ),
      ).toEqual([]);
      expect(outcomes.elapsedMs).toBeLessThan(2_000);
      expect(party.dials.filter((dial) => dial.settled === "rejected")).toEqual(
        [],
      );
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a safeDelete fan-out torn by one clean drop keeps its never-reject contract",
  async () => {
    // The no-regression half. safeDelete sits OUTSIDE the recovery chokepoint by
    // its never-reject contract, so no member of this fan dials into the window
    // the case above is about; what a drop must not do is break the contract the
    // connection cleanup and the rendezvous sweeps rely on.
    const party = await connectParty({
      maxReconnectAttempts: 4,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const targets = await plantFanOut(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const outcomes = await withCapturedLogs(
        async () => {
          controls.dropActiveAfterOps(1);
          return Promise.allSettled(
            targets.map((target) => party.adapter.safeDelete(target)),
          );
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(outcomes.map(describeSettlement)).toEqual(
        targets.map(() => ({ status: "fulfilled", detail: "undefined" })),
      );
      expect(
        (await fsp.readdir(party.localDir)).filter((name) =>
          name.startsWith("victim-"),
        ),
      ).toEqual([]);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a heartbeat left on the wire by a withheld close settles on the concurrent " +
    "read's forced close, not on its own deadline",
  async () => {
    // The beat as the OTHER operation. Against a partner that drops the SFTP
    // session and withholds its connection close there is no tear at all: the
    // transport stays half-open and both the read and the beat are left on a wire
    // that can carry nothing. What settles the beat is the read's own recovery
    // forcing that transport closed -- a close this side drives, needing nothing
    // from the partner -- rather than the beat's per-operation deadline.
    const party = await connectParty({
      maxReconnectAttempts: 4,
      stallDeadlineMs: STALL_DEADLINE_MS,
      withholdCloseOnDisconnect: true,
    });
    try {
      const remoteFile = await plantTransfer(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const outcomes = await withCapturedLogs(
        async () => {
          controls.dropActiveAfterOps(24);
          const read = Promise.allSettled([
            party.adapter.get(remoteFile, { maxBytes: READ_CAP_BYTES }),
          ]);
          // Well after the cut has landed (the transfer reaches its 24th opcode
          // within a few ms), so the beat is written into a transport this side
          // still believes is live and the server has already abandoned. Late
          // enough, too, that the span it then spends outstanding is nowhere near
          // its own deadline, so the deadline is not what could be settling it.
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const beatStartedAt = performance.now();
          const settledBeat = await Promise.allSettled([
            (
              party.adapter as unknown as { sendKeepalive: () => Promise<void> }
            ).sendKeepalive(),
          ]).then(([outcome]) => outcome);
          const beatMs = performance.now() - beatStartedAt;
          const settledRead = await read.then(([outcome]) => outcome);
          return { settledBeat, beatMs, settledRead };
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      // The beat is torn by the forced close rather than left to its own bound.
      expect(stalled(outcomes.settledBeat)).toBe(false);
      expect(outcomes.settledBeat.status).toBe("rejected");
      expect(outcomes.beatMs).toBeLessThan(STALL_DEADLINE_MS);
      // And it was genuinely outstanding across that recovery rather than refused
      // on entry, which would settle it without ever reaching the transport.
      expect(outcomes.beatMs).toBeGreaterThan(500);
      // And the read it was concurrent with completes across that same recovery.
      expect(describeSettlement(outcomes.settledRead)).toEqual({
        status: "fulfilled",
        detail: `Buffer(${TRANSFER_BYTES})`,
      });
      expect(party.dials.filter((dial) => dial.settled === "rejected")).toEqual(
        [],
      );
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "a heartbeat parked on the wire at a clean drop settles on the tear, not on " +
    "its own deadline",
  async () => {
    // The same beat against the other partner class. A beat only reaches the wire
    // while the session is idle, and a healthy server answers it in a round trip,
    // so putting one THERE when a clean cut lands means holding its REALPATH
    // unanswered -- the server-side withhold this drives. The read issued behind
    // it is the operation whose recovery re-dial runs; the beat is the concurrent
    // one, and its own outcome is swallowed by the heartbeat, so what matters is
    // that it settles at all rather than pinning the session for a full deadline.
    const party = await connectParty({
      maxReconnectAttempts: 4,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const remoteFile = await plantTransfer(party);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const outcomes = await withCapturedLogs(
        async () => {
          party.srv.inject.withholdOn = "REALPATH";
          const beatStartedAt = performance.now();
          const beat = Promise.allSettled([
            (
              party.adapter as unknown as { sendKeepalive: () => Promise<void> }
            ).sendKeepalive(),
          ]);
          let beatSettled = false;
          void beat.then(() => {
            beatSettled = true;
          });
          // Long enough for the REALPATH to reach the server and be counted, so
          // the cut armed next lands inside the transfer rather than on the beat.
          await new Promise((resolve) => setTimeout(resolve, 100));
          const parkedBeforeCut = !beatSettled;
          controls.dropActiveAfterOps(24);
          const read = Promise.allSettled([
            party.adapter.get(remoteFile, { maxBytes: READ_CAP_BYTES }),
          ]);
          const settledBeat = await beat.then(([outcome]) => outcome);
          const beatMs = performance.now() - beatStartedAt;
          const settledRead = await read.then(([outcome]) => outcome);
          return { parkedBeforeCut, settledBeat, beatMs, settledRead };
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      // The beat was genuinely outstanding when the cut landed rather than long
      // since answered, which is what makes the rest of this a measurement.
      expect(outcomes.parkedBeforeCut).toBe(true);
      expect(stalled(outcomes.settledBeat)).toBe(false);
      expect(outcomes.settledBeat.status).toBe("rejected");
      expect(outcomes.beatMs).toBeLessThan(STALL_DEADLINE_MS);
      // The read whose recovery ran across it completes with its own result.
      expect(describeSettlement(outcomes.settledRead)).toEqual({
        status: "fulfilled",
        detail: `Buffer(${TRANSFER_BYTES})`,
      });
      expect(controls.handshakeCount()).toBe(1);
      expect(party.dials.filter((dial) => dial.settled === "rejected")).toEqual(
        [],
      );
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
