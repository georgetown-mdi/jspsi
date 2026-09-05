import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import {
  FileSyncConnection,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";
import { inProcessOnly } from "../sftpBackendGate";

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
  ephemeralSessions?: boolean;
}): Promise<Party> {
  const srv = await startInProcessSftpServer();
  // Every case calls this outside its own try, so nothing else owns what is
  // allocated below once the dial throws: unwound here, a failed setup surfaces its
  // own error; unwound nowhere, it leaves its listening server and its temp
  // directory alive for the rest of the worker's life.
  let allocatedDir: string | undefined;
  let openedConn: FileSyncConnection | undefined;
  try {
    const localDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "concurrent-"),
    );
    allocatedDir = localDir;
    const remote = `${srv.handle.remoteRoot}/${path.basename(localDir)}`;
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: options.ephemeralSessions ?? false,
      ...(options.stallDeadlineMs === undefined
        ? {}
        : { stallDeadlineMs: options.stallDeadlineMs }),
    });
    const dials = recordDials(adapter);
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    openedConn = conn;
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
    // From here on the record holds only the dials a case provoked; the party's
    // own first connect is setup, not a subject.
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
        // closes: one left armed cuts or withholds from the teardown instead of
        // the call under test.
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
  } catch (error: unknown) {
    await openedConn?.close().catch(() => {});
    if (allocatedDir !== undefined)
      await fsp.rm(allocatedDir, { recursive: true, force: true });
    await srv.stop();
    throw error;
  }
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
  return plantDeletables(party, "victim", FAN_OUT_FILES);
}

// `width` files a delete fan can be aimed at, named off `prefix` so successive
// fans in one case cannot collide: a delete leaves the name free again, and a
// re-issue that answered from the delete-absent relaxation would then be
// indistinguishable from one that landed.
async function plantDeletables(
  party: Party,
  prefix: string,
  width: number,
): Promise<string[]> {
  const targets: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const name = `${prefix}-${index}.json`;
    await fsp.writeFile(path.join(party.localDir, name), "{}");
    targets.push(`${party.remote}/${name}`);
  }
  return targets;
}

// Every operator-facing line reporting a transparently recovered mid-exchange
// drop, in either mode and at either cadence: the first re-dial's wording and the
// running-total wording share this fragment, so a case counting them cannot pass
// by matching only the shape it expected.
function recoveryWarnings(
  logs: readonly { readonly message: string }[],
): readonly string[] {
  return logs
    .map((entry) => entry.message)
    .filter((message) => message.includes("transparently re-dial"));
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
      // The whole fan cost one tear, not one per torn member: a fan that re-dialed
      // per member would carry the same results, land inside the same ceiling, and
      // reject no dial, so nothing else here separates the two.
      expect(controls.handshakeCount()).toBe(1);
      expect(party.dials).toHaveLength(1);
      expect(party.dials.filter((dial) => dial.settled === "rejected")).toEqual(
        [],
      );
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// What the drop COST, against what the operator is told it cost. The dial is
// coalesced by the transition queue whatever the fan's width -- the case above
// pins that -- so the server serves one handshake per drop, and the counters, the
// budget, and the warning stream are held to the same unit here. The server's own
// handshake tally is the ground truth on the left-hand side of every comparison:
// the adapter's bookkeeping is the thing under test and cannot also be the
// reference for it.
for (const [shape, width] of [
  ["a single operation", 1],
  ["a fan-out of concurrent operations", FAN_OUT_FILES],
] as const)
  inProcessOnly(
    `one clean drop tearing ${shape} is one re-dial in the counters and one ` +
      `warning to the operator`,
    async () => {
      const party = await connectParty({
        maxReconnectAttempts: 6,
        stallDeadlineMs: STALL_DEADLINE_MS,
      });
      try {
        const targets = await plantDeletables(party, "counted", width);
        const controls = party.srv.sessionControls;
        controls.resetHandshakeCount();

        const [settled, logs] = await withCapturedLogs(
          async () => {
            controls.dropActiveAfterOps(1);
            return Promise.allSettled(
              targets.map((target) => party.adapter.delete(target)),
            );
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        // The invariant every assertion below rests on: whatever the accounting
        // says, each member of the fan resolved on its own result and the deletes
        // landed. A fix that bought truthful counters by failing the members past
        // the first would satisfy the rest of this case and break the exchange.
        expect(settled.filter(stalled)).toEqual([]);
        expect(settled.map(describeSettlement)).toEqual(
          targets.map(() => ({ status: "fulfilled", detail: "undefined" })),
        );
        expect(
          (await fsp.readdir(party.localDir)).filter((name) =>
            name.startsWith("counted-"),
          ),
        ).toEqual([]);

        // One drop, one handshake served, and one re-dial in each counter: the
        // operator's budget is charged for the drop rather than for the operations
        // it happened to tear.
        expect(controls.handshakeCount()).toBe(1);
        expect(party.dials).toHaveLength(1);
        expect(party.adapter.midExchangeReconnectCount).toBe(
          controls.handshakeCount(),
        );
        expect(party.adapter.reconnectCount).toBe(controls.handshakeCount());
        // And the operator hears about the drop exactly once. The warn cadence
        // reads the same counter, so a per-member count would repeat this line
        // several times over for the one drop it describes.
        expect(recoveryWarnings(logs)).toHaveLength(1);
      } finally {
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  "two drops of two successive sessions report two, once each",
  async () => {
    // The other direction from the once-per-loss cases above, and the one an
    // accounting keyed to a high-water mark gets wrong: two GENUINE losses, of two
    // different sessions, must report as two. A charge gated on "newer than the
    // newest loss already accounted for" drops the second wherever an arm carries
    // a generation the gate has passed, and the failure looks exactly like the
    // once-per-loss property working. Driven with a fan at each drop, so an arm of
    // the first drop's fan and an arm of the second's are both in play.
    const party = await connectParty({
      maxReconnectAttempts: 6,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const [progress, logs] = await withCapturedLogs(
        async () => {
          const spent: { counted: number; handshakes: number }[] = [];
          for (const drop of [0, 1]) {
            const targets = await plantDeletables(
              party,
              `generation${drop}`,
              FAN_OUT_FILES,
            );
            controls.dropActiveAfterOps(1);
            const settled = await Promise.allSettled(
              targets.map((target) => party.adapter.delete(target)),
            );
            expect(settled.filter(stalled)).toEqual([]);
            expect(settled.map(describeSettlement)).toEqual(
              targets.map(() => ({
                status: "fulfilled",
                detail: "undefined",
              })),
            );
            spent.push({
              counted: party.adapter.midExchangeReconnectCount,
              handshakes: controls.handshakeCount(),
            });
          }
          return spent;
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      // Each drop moved both by exactly one: two sessions lost, two handshakes
      // served, neither drop swallowed by the other and neither counted twice.
      expect(progress).toEqual([
        { counted: 1, handshakes: 1 },
        { counted: 2, handshakes: 2 },
      ]);
      expect(party.dials).toHaveLength(2);
      expect(party.adapter.reconnectCount).toBe(2);
      // One line, not one per torn operation: the second drop falls inside the
      // shared warn cadence (the first, then every tenth) and the run total the
      // teardown summary carries is what reports it.
      expect(recoveryWarnings(logs)).toHaveLength(1);
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

// The budget of drops the operator configured, spent at a fan-out width well
// above it. The last drop the budget permits is deliberately the wide fan, so the
// boundary is reached with a fan-out tearing at it: an accounting that charged per
// torn operation would refuse the exchange partway through this sequence rather
// than at its end.
const SPENDABLE_DROPS = 3;

for (const [shape, width] of [
  ["a single operation", 1],
  ["a fan-out of concurrent operations", FAN_OUT_FILES],
] as const)
  inProcessOnly(
    `a mid-exchange reconnect budget of ${SPENDABLE_DROPS} survives ` +
      `${SPENDABLE_DROPS} drops tearing ${shape} and refuses the next`,
    async () => {
      const party = await connectParty({
        maxReconnectAttempts: SPENDABLE_DROPS,
        stallDeadlineMs: STALL_DEADLINE_MS,
      });
      try {
        const controls = party.srv.sessionControls;
        controls.resetHandshakeCount();

        const [progress, logs] = await withCapturedLogs(
          async () => {
            const spent: { counted: number; handshakes: number }[] = [];
            // Alternating widths, so the budget is spent by drops of both shapes
            // and the LAST one it permits is the wide fan: the boundary is reached
            // by the number of drops rather than by any one drop's width.
            for (const [stage, stageWidth] of [width, 1, width].entries()) {
              const targets = await plantDeletables(
                party,
                `stage${stage}`,
                stageWidth,
              );
              controls.dropActiveAfterOps(1);
              const settled = await Promise.allSettled(
                targets.map((target) => party.adapter.delete(target)),
              );
              expect(settled.map(describeSettlement)).toEqual(
                targets.map(() => ({
                  status: "fulfilled",
                  detail: "undefined",
                })),
              );
              spent.push({
                counted: party.adapter.midExchangeReconnectCount,
                handshakes: controls.handshakeCount(),
              });
            }
            return spent;
          },
          (level) => level === "WARN" || level === "ERROR",
        );

        // Each drop spent exactly one unit, and each unit bought exactly one
        // handshake.
        expect(progress).toEqual([
          { counted: 1, handshakes: 1 },
          { counted: 2, handshakes: 2 },
          { counted: 3, handshakes: 3 },
        ]);
        // Paced, as the cadence intends: the first re-dial and the last one the
        // budget permits, the every-tenth escalation never firing at a budget this
        // small. Charging per torn operation instead would reach the last-allowed
        // line on the first drop and then repeat it for every further member.
        expect(recoveryWarnings(logs)).toHaveLength(2);
        expect(
          recoveryWarnings(logs).filter((message) =>
            message.includes("was the last re-dial allowed"),
          ),
        ).toHaveLength(1);

        // With the budget spent, the next drop is terminal -- on the budget,
        // naming it and its remedies, rather than on a dial or a stall.
        const [beyond] = await plantDeletables(party, "beyond", 1);
        controls.dropActiveAfterOps(1);
        const refused = await withCapturedLogs(
          async () =>
            party.adapter.delete(beyond).then(
              () => undefined,
              (error: unknown) => error,
            ),
          (level) => level === "WARN" || level === "ERROR",
        ).then(([result]) => result);

        expect(refused).toBeInstanceOf(UsageError);
        expect((refused as Error).message).toContain(
          `max_reconnect_attempts=${SPENDABLE_DROPS}`,
        );
        expect((refused as Error).message).toContain("--connection-per-poll");
        // Refused rather than dialed: the budget bought no handshake past the
        // ones it allowed. The refused drop is still counted -- the budget bounds
        // sessions LOST rather than re-dials made -- so the counter runs one
        // ahead of the handshakes at exactly the point of refusal.
        expect(controls.handshakeCount()).toBe(SPENDABLE_DROPS);
        expect(party.dials).toHaveLength(SPENDABLE_DROPS);
        expect(party.adapter.midExchangeReconnectCount).toBe(
          SPENDABLE_DROPS + 1,
        );
      } finally {
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  "a fan-out against a server that drops every session it opens spends no more " +
    "of the budget than the handshakes it served",
  async () => {
    // The other side of the accounting. Every arm of the fan reads the budget
    // before the first of them has spent any of it, so what stops the fan from
    // dialing past the cap is not that reading but the coalescing: the arms drain
    // the transition queue in one microtask cascade behind the one dial, with no
    // window for a further drop to land between them. Driven against the partner
    // that would exploit any such window -- a standing cap that drops EVERY session
    // after its first operation -- so the bound is measured rather than reasoned
    // about. How many members complete against such a server is not the subject and
    // is left unasserted; what is asserted is that the budget bought no more
    // handshakes than it allowed.
    const budget = 1;
    const party = await connectParty({
      maxReconnectAttempts: budget,
      stallDeadlineMs: STALL_DEADLINE_MS,
    });
    try {
      const targets = await plantDeletables(party, "capped", FAN_OUT_FILES);
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const settled = await withCapturedLogs(
        async () => {
          controls.maxOps = 1;
          return Promise.allSettled(
            targets.map((target) => party.adapter.delete(target)),
          );
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      // Each member was settled by its own tear rather than left for the liveness
      // deadline, which is what says the recovery arms all ran.
      expect(settled.filter(stalled)).toEqual([]);
      // One handshake per re-dial, and no more re-dials than the budget allowed.
      // The bound is read on the HANDSHAKES rather than on the counter: against a
      // server that drops every session it opens, the sessions lost exceed the
      // re-dials the budget bought, and it is the re-dials the budget bounds.
      expect(controls.handshakeCount()).toBe(party.dials.length);
      expect(controls.handshakeCount()).toBeLessThanOrEqual(budget);
      expect(controls.handshakeCount()).toBeGreaterThan(0);
      expect(party.adapter.midExchangeReconnectCount).toBeGreaterThanOrEqual(
        controls.handshakeCount(),
      );
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "in connection-per-poll mode a torn fan-out counts one re-dial and the drops " +
    "past the budget are still recovered",
  async () => {
    // The same fan-out in the other mode, where the budget gate is deliberately
    // not applied at all: the mode's own lifecycle re-dials once per poll cycle,
    // so charging it a cumulative cap would end healthy exchanges. The counters
    // still have to be truthful there -- they are what an operator reads to tell a
    // chronic capper from a healthy run -- and the absence of the refusal is driven
    // rather than assumed, by taking more drops than the configured budget.
    const budget = 2;
    const dropsPastTheBudget = 3;
    const party = await connectParty({
      maxReconnectAttempts: budget,
      stallDeadlineMs: STALL_DEADLINE_MS,
      ephemeralSessions: true,
    });
    try {
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const outcome = await withCapturedLogs(
        async () => {
          const fan = await plantDeletables(party, "perpoll", FAN_OUT_FILES);
          controls.dropActiveAfterOps(1);
          const settledFan = await Promise.allSettled(
            fan.map((target) => party.adapter.delete(target)),
          );
          const afterTheFan = {
            counted: party.adapter.midExchangeReconnectCount,
            handshakes: controls.handshakeCount(),
          };
          // Genuinely separate drops, each tearing one operation, taken past the
          // point a held-session exchange would have been refused.
          const beyond = await plantDeletables(
            party,
            "beyond",
            dropsPastTheBudget,
          );
          const settledBeyond: PromiseSettledResult<void>[] = [];
          for (const target of beyond) {
            controls.dropActiveAfterOps(1);
            settledBeyond.push(
              ...(await Promise.allSettled([party.adapter.delete(target)])),
            );
          }
          return { settledFan, afterTheFan, settledBeyond };
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(outcome.settledFan.filter(stalled)).toEqual([]);
      expect(
        outcome.settledFan.filter((member) => member.status === "rejected"),
      ).toEqual([]);
      // One drop, one counted re-dial, one handshake -- as in the default mode.
      expect(outcome.afterTheFan).toEqual({ counted: 1, handshakes: 1 });
      // Every later drop recovered too: nothing in this mode refuses on the
      // cumulative budget, so the run passes the configured 2 without a refusal.
      expect(outcome.settledBeyond.map(describeSettlement)).toEqual(
        Array.from({ length: dropsPastTheBudget }, () => ({
          status: "fulfilled" as const,
          detail: "undefined",
        })),
      );
      const drops = 1 + dropsPastTheBudget;
      expect(drops).toBeGreaterThan(budget);
      expect(controls.handshakeCount()).toBe(drops);
      expect(party.adapter.midExchangeReconnectCount).toBe(
        controls.handshakeCount(),
      );
      expect(party.adapter.reconnectCount).toBe(controls.handshakeCount());
    } finally {
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "an idle boundary around a torn fan-out leaves the drop counted once and the " +
    "deliberate release counted not at all",
  async () => {
    // Where this accounting meets the connection-per-poll session lifecycle. Two
    // boundaries in sequence, each meeting a wide fan of deletes:
    //   - one reached while the fan is outstanding, which keeps its session rather
    //     than cutting the fan off the wire, so the partner's drop is still the
    //     only loss and is counted once;
    //   - one reached with the wire empty, which ends the session itself, after
    //     which a fresh fan re-establishes through the gate ahead of it -- a
    //     lifecycle transition rather than a survived drop, counted nowhere.
    // Driven at the adapter rather than through a poll loop because neither
    // boundary falls on demand from inside one.
    const party = await connectParty({
      maxReconnectAttempts: 4,
      stallDeadlineMs: STALL_DEADLINE_MS,
      ephemeralSessions: true,
    });
    try {
      const controls = party.srv.sessionControls;
      controls.resetHandshakeCount();

      const [outcome, logs] = await withCapturedLogs(
        async () => {
          const torn = await plantDeletables(party, "straddle", FAN_OUT_FILES);
          controls.dropActiveAfterOps(1);
          // Issued, then the boundary, in one turn: the release reaches the front
          // of an idle transition queue in this same tick and reads the fan
          // outstanding, so it is the held-boundary placement rather than a close.
          const settledTorn = Promise.allSettled(
            torn.map((target) => party.adapter.delete(target)),
          );
          const held = party.adapter.releaseForIdle();
          const tornOutcomes = await settledTorn;
          await held;
          const afterTheTornFan = {
            counted: party.adapter.midExchangeReconnectCount,
            handshakes: controls.handshakeCount(),
            heldBoundaries: party.adapter.heldBoundaryCount,
          };

          // With the wire empty, this boundary is the release's own to close.
          await party.adapter.releaseForIdle();
          const fresh = await plantDeletables(
            party,
            "afterIdle",
            FAN_OUT_FILES,
          );
          const settledFresh = await Promise.allSettled(
            fresh.map((target) => party.adapter.delete(target)),
          );
          return { tornOutcomes, afterTheTornFan, settledFresh };
        },
        (level) => level === "WARN" || level === "ERROR",
      );

      expect(outcome.tornOutcomes.filter(stalled)).toEqual([]);
      expect(
        outcome.tornOutcomes.filter((member) => member.status === "rejected"),
      ).toEqual([]);
      // The boundary kept its session for the fan, so the only loss was the
      // partner's and it is counted once against the one handshake it cost.
      expect(outcome.afterTheTornFan).toEqual({
        counted: 1,
        handshakes: 1,
        heldBoundaries: 1,
      });

      // The fan issued after the deliberate release re-establishes once through
      // the gate ahead of it and every member resolves on that session.
      expect(
        outcome.settledFresh.filter((member) => member.status === "rejected"),
      ).toEqual([]);
      expect(controls.handshakeCount()).toBe(2);
      // Neither counter moved for the release's own re-establishment, and the
      // whole run reported the one partner drop once.
      expect(party.adapter.midExchangeReconnectCount).toBe(1);
      expect(party.adapter.reconnectCount).toBe(1);
      expect(party.adapter.forcedReleaseCount).toBe(0);
      expect(recoveryWarnings(logs)).toHaveLength(1);
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
          const startedAt = performance.now();
          const settled = await Promise.allSettled(
            targets.map((target) => party.adapter.safeDelete(target)),
          );
          return { settled, elapsedMs: performance.now() - startedAt };
        },
        (level) => level === "WARN" || level === "ERROR",
      ).then(([result]) => result);

      expect(outcomes.settled.map(describeSettlement)).toEqual(
        targets.map(() => ({ status: "fulfilled", detail: "undefined" })),
      );
      expect(
        (await fsp.readdir(party.localDir)).filter((name) =>
          name.startsWith("victim-"),
        ),
      ).toEqual([]);
      // Neither assertion above can see what the client saw: safeDelete swallows
      // every error by its contract, and the server unlinks the whole fan in the
      // turn before the cut, so both stand even for a member left riding its
      // liveness deadline. The ceiling is the only thing here that separates a fan
      // settled by its tear from one settled by a deadline apiece.
      expect(outcomes.elapsedMs).toBeLessThan(500);
      expect(controls.handshakeCount()).toBe(0);
      expect(party.dials).toHaveLength(0);
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
