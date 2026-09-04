import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { MAX_DIRECTORY_ENTRIES } from "../../src/connection/listingGuard";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { startInProcessSftpServer } from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";
import { inProcessOnly } from "../sftpBackendGate";

// Core issues its rendezvous and cleanup deletes as concurrent fans on the ONE
// SFTP channel a party holds, and none of them carries a width cap of its own.
// The entry sweep's fan is bounded only by the two directory listings it merges
// (twice MAX_DIRECTORY_ENTRIES under a split scope); the entry scan's narrower
// sweeps by one listing each; the connection cleanup's by what a party's own
// poll listing would have refused. What a fan that wide DOES is driven here
// rather than argued: the in-process backend serves it, and the in-flight
// request count is read at the SERVER -- the end this project owns -- rather
// than out of the client library's request table.
//
// Each case holds the same four things about the fan it drives: every delete in
// it reached the server, every one of them was answered there, every target is
// gone afterwards, and the whole fan rode one SSH session with no re-dial. The
// sweep's own error is held to naming every failure at full width, since that
// report is what an operator is left with when a wide sweep partially fails.
//
// The ladder drives the delete-fan SHAPE -- one never-reject delete per name,
// dispatched in a single turn -- which is what all of these issue; the two
// widths that matter are then driven through the real paths that build them, the
// entry sweep over a split scope and the connection cleanup. The entry scan's
// narrower sweeps have no case of their own: each is that same shape over a
// subset of ONE listing, whose full width the connection-cleanup case drives and
// the ladder's rungs bracket.
//
// THE WIDTHS DRIVEN BELOW ARE THIS FILE'S BOUND. They reach the enforced listing
// bound and the split-scope union of two listings, which is the widest fan these
// paths can put on a channel -- but a passing run is evidence for the widths
// driven, not a claim about every width, and nothing here predicts a width or a
// failure a run has not produced.
//
// Only the in-process backend exposes the session controls this reads (see
// test/sftpServer/types.ts), so these run there.

const TEST_TIMEOUT_MS = 300_000;

/** The widest fan core's entry sweep can build: two full listings, merged. */
const SPLIT_SCOPE_FAN_WIDTH = 2 * MAX_DIRECTORY_ENTRIES;

// The ladder. The first three rungs are the widths the shared-client listener
// ceiling was driven at (sharedClientListenerCeiling.test.ts), so the two files
// are comparable at the bottom; the rest climb past them to the split-scope
// union of two listings.
const FAN_WIDTHS = [9, 40, 512, 2048, SPLIT_SCOPE_FAN_WIDTH] as const;

// Entries the in-process backend answers per READDIR round trip in the cases
// that make it list a full directory, kept far below the backend's byte budget
// so those listings cross the wire as many narrow replies rather than one wide
// one. The backend delivers a listing of any width at any setting of this --
// wideDirectoryListing.test.ts is what asserts delivery and the round-trip
// floor -- so what this value buys is round-trip realism rather than delivery.
const SERVER_READDIR_BATCH = 100;

// What has to have stood unanswered at the server at once for the fan to have
// been driven concurrently at all: an eighth of its width, and never fewer than
// two. Held as a FRACTION so the claim scales with the width, and set far under
// every peak driven here -- each is several times this -- because what it has to
// exclude is a one-at-a-time drain rather than a particular pipeline depth. A
// tighter floor would be read off the wire race instead: the narrowest rung, on
// a cold first run, can have its earliest replies back before its last requests
// are written, which is not a serialized drain.
const CONCURRENT_FRACTION_OF_FAN = 8;

function concurrencyFloor(width: number): number {
  return Math.min(
    width,
    Math.max(2, Math.floor(width / CONCURRENT_FRACTION_OF_FAN)),
  );
}

// Undeletable entries planted into the widest sweep, so the failure report is
// exercised where it costs the most: a directory rather than a file, which the
// server refuses to REMOVE.
const UNDELETABLE_ENTRIES = 5;

// Messages the driven exchange carries before its cleanup fan is measured.
const EXCHANGE_MESSAGES = 20;

// The delete-mode send gate holds the sender to one unconsumed message, and each
// poll listing prunes the rest, so what an exchange leaves for cleanup() is a
// handful of names rather than a listing's worth. Held as a ceiling on the
// driven exchange, not as a bound on the fan: the resource envelope that fan
// could reach is covered separately at MAX_DIRECTORY_ENTRIES.
const EXCHANGE_CLEANUP_FAN_CEILING = 8;

// ---------------------------------------------------------------------------

/** Deletes the server has taken in since the meter was last reset. */
function deletesReceived(srv: InProcessSftpServer): number {
  return srv.sessionControls.requests.read().receivedByOp.REMOVE ?? 0;
}

/** Deletes the server has answered since the meter was last reset. */
function deletesAnswered(srv: InProcessSftpServer): number {
  return srv.sessionControls.requests.read().answeredByOp.REMOVE ?? 0;
}

/**
 * Everything a driven fan is held to that is read from the server: the fan's
 * whole width arrived, all of it was answered, the pipeline really ran
 * concurrently, and no re-dial carried part of it. Returned as messages rather
 * than a bare boolean so a failure names which of the four broke.
 *
 * Counted over the fan's own width rather than over every request in flight,
 * because a fan driven through a real entry is followed straight away by the
 * rendezvous operations that come after it; those are not part of the fan, and
 * whether they are in flight when this reads says nothing about it.
 */
function fanViolations(srv: InProcessSftpServer, width: number): string[] {
  const reading = srv.sessionControls.requests.read();
  const received = reading.receivedByOp.REMOVE ?? 0;
  const answered = reading.answeredByOp.REMOVE ?? 0;
  const violations: string[] = [];
  if (received < width)
    violations.push(
      `${received} delete(s) reached the server, expected ${width}`,
    );
  if (answered < width)
    violations.push(
      `only ${answered} of the ${width} delete(s) were answered, so ` +
        `${width - answered} never settled at the server`,
    );
  if (reading.peakOutstanding < concurrencyFloor(width))
    violations.push(
      `at most ${reading.peakOutstanding} request(s) stood unanswered at once, ` +
        `under the ${concurrencyFloor(width)} a fan of ${width} driven ` +
        `concurrently reaches`,
    );
  if (srv.sessionControls.handshakeCount() !== 0)
    violations.push(
      `the fan spanned ${srv.sessionControls.handshakeCount() + 1} sessions, not one`,
    );
  return violations;
}

/** Start a measurement window over the session already established. */
function beginWindow(srv: InProcessSftpServer): void {
  srv.sessionControls.requests.reset();
  srv.sessionControls.resetHandshakeCount();
}

/** Wait until the server has answered `count` deletes, or the deadline passes. */
async function awaitDeletes(
  srv: InProcessSftpServer,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (deletesAnswered(srv) < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waited for ${what} and it did not happen`);
}

async function plant(dir: string, names: readonly string[]): Promise<void> {
  const perTurn = 512;
  for (let index = 0; index < names.length; index += perTurn)
    await Promise.all(
      names
        .slice(index, index + perTurn)
        .map((name) => fsp.writeFile(path.join(dir, name), "{}")),
    );
}

/**
 * `count` names that match the protocol filename grammar and are neither a peer
 * hello nor an in-flight temp, so the entry scan classifies every one of them as
 * an unexpected protocol file: the classification the sweep's fan is built from.
 */
function protocolLeftoverNames(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(6, "0")}-lock.json`,
  );
}

interface Party {
  adapter: SSH2SFTPClientAdapter;
  conn: FileSyncConnection;
  remote: string;
  localDir: string;
  stop: () => Promise<void>;
}

/** One connected party over a directory of its own, as protocol.ts dials. */
async function connectParty(srv: InProcessSftpServer): Promise<Party> {
  let allocatedDir: string | undefined;
  let openedConn: FileSyncConnection | undefined;
  try {
    const localDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "fan-"),
    );
    allocatedDir = localDir;
    const remote = `${srv.handle.remoteRoot}/${path.basename(localDir)}`;
    const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 50,
    });
    openedConn = conn;
    conn.on("error", () => {});
    await withCapturedLogs(
      async () =>
        conn.open({
          channel: "sftp",
          server: {
            host: srv.handle.host,
            port: srv.handle.port,
            ...serverAuth(srv.handle.usera),
            path: remote,
          },
        }),
      () => true,
    );
    return {
      adapter,
      conn,
      remote,
      localDir,
      stop: async () => {
        await conn.close().catch(() => {});
        await fsp.rm(localDir, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await openedConn?.close().catch(() => {});
    if (allocatedDir !== undefined)
      await fsp.rm(allocatedDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A party entering a split inbound/outbound scope under the opt-in sweep. Split
 * mode requires retain mode, and retain mode is itself a retain signal the sweep
 * refuses on, so the escalation flag is what lets the sweep run -- which is the
 * only configuration that reaches the two-listing fan at all.
 */
function sweepingConnection(
  adapter: SSH2SFTPClientAdapter,
): FileSyncConnection {
  const conn = new FileSyncConnection(adapter, {
    verbose: -1,
    pollingFrequency: 50,
    retainFiles: true,
    locklessRendezvous: true,
    timestampInFilename: true,
    sweepExchangeFiles: true,
    forceRetainSweep: true,
  });
  conn.on("error", () => {});
  return conn;
}

async function openSplitScope(
  srv: InProcessSftpServer,
  conn: FileSyncConnection,
  inbound: string,
  outbound: string,
): Promise<void> {
  await withCapturedLogs(
    async () =>
      conn.open({
        channel: "sftp",
        server: {
          host: srv.handle.host,
          port: srv.handle.port,
          ...serverAuth(srv.handle.usera),
          inboundPath: inbound,
          outboundPath: outbound,
        },
      }),
    () => true,
  );
}

// ---------------------------------------------------------------------------

for (const width of FAN_WIDTHS)
  inProcessOnly(
    `a delete fan of ${width} lands every delete on one channel`,
    async () => {
      // The shape every one of core's delete fans issues -- one never-reject
      // delete per name, dispatched in a single turn -- driven at each rung so
      // the ladder shows whether anything changes between the widths a real
      // exchange produces and the widths the bounds permit.
      const srv = await startInProcessSftpServer();
      const party = await connectParty(srv);
      try {
        const names = protocolLeftoverNames("w", width);
        await plant(party.localDir, names);
        beginWindow(srv);
        await withCapturedLogs(
          async () =>
            Promise.all(
              names.map((name) =>
                party.adapter.safeDelete(`${party.remote}/${name}`),
              ),
            ),
          () => true,
        );

        expect(fanViolations(srv, width)).toEqual([]);
        expect(await fsp.readdir(party.localDir)).toEqual([]);
      } finally {
        await party.stop();
        await srv.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  `core's entry sweep fans ${SPLIT_SCOPE_FAN_WIDTH} deletes over a split scope`,
  async () => {
    // The widest fan, through the path that really builds it: a split scope
    // whose two directories are each filled to the listing bound, entered under
    // the opt-in sweep, so the merged union is twice that bound. One peer hello
    // sits among the inbound leftovers so both classifications the union is
    // built from are represented.
    const srv = await startInProcessSftpServer();
    srv.inject.readdirBatchSize = SERVER_READDIR_BATCH;
    const inboundDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "sweep-in-"),
    );
    const outboundDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "sweep-out-"),
    );
    const inbound = `${srv.handle.remoteRoot}/${path.basename(inboundDir)}`;
    const outbound = `${srv.handle.remoteRoot}/${path.basename(outboundDir)}`;
    const inboundNames = [
      `${randomUUID()}-hello.json`,
      ...protocolLeftoverNames("i", MAX_DIRECTORY_ENTRIES - 1),
    ];
    const outboundNames = protocolLeftoverNames("o", MAX_DIRECTORY_ENTRIES);
    await plant(inboundDir, inboundNames);
    await plant(outboundDir, outboundNames);

    const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    const conn = sweepingConnection(adapter);
    try {
      await openSplitScope(srv, conn, inbound, outbound);
      beginWindow(srv);
      // synchronize() sweeps and then waits out a rendezvous no peer will
      // answer, so the fan is observed through the server's own delete count and
      // the connection is torn down under it.
      const rendezvous = withCapturedLogs(
        async () => conn.synchronize(),
        () => true,
      ).catch(() => undefined);
      await awaitDeletes(srv, SPLIT_SCOPE_FAN_WIDTH);
      const violations = fanViolations(srv, SPLIT_SCOPE_FAN_WIDTH);

      expect(violations).toEqual([]);
      expect(await fsp.readdir(inboundDir)).not.toContain(inboundNames[0]);
      expect(
        (await fsp.readdir(inboundDir)).filter((name) =>
          name.endsWith("-lock.json"),
        ),
      ).toEqual([]);
      expect(
        (await fsp.readdir(outboundDir)).filter((name) =>
          name.endsWith("-lock.json"),
        ),
      ).toEqual([]);
      await conn.close().catch(() => {});
      await rendezvous;
    } finally {
      await conn.close().catch(() => {});
      await fsp.rm(inboundDir, { recursive: true, force: true });
      await fsp.rm(outboundDir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `the entry sweep names every failure in a fan of ${SPLIT_SCOPE_FAN_WIDTH}`,
  async () => {
    // The sweep settles every delete before it reports, so a fan this wide with
    // failures in it must still leave the directories fully attempted and name
    // each failure -- the report is all an operator has to act on. Directories
    // stand in for the undeletable entries: the server refuses to REMOVE one.
    const srv = await startInProcessSftpServer();
    srv.inject.readdirBatchSize = SERVER_READDIR_BATCH;
    const inboundDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "fail-in-"),
    );
    const outboundDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "fail-out-"),
    );
    const inbound = `${srv.handle.remoteRoot}/${path.basename(inboundDir)}`;
    const outbound = `${srv.handle.remoteRoot}/${path.basename(outboundDir)}`;
    const inboundNames = protocolLeftoverNames("i", MAX_DIRECTORY_ENTRIES);
    const undeletable = inboundNames.slice(-UNDELETABLE_ENTRIES);
    const outboundNames = protocolLeftoverNames("o", MAX_DIRECTORY_ENTRIES);
    await plant(inboundDir, inboundNames.slice(0, -UNDELETABLE_ENTRIES));
    for (const name of undeletable)
      await fsp.mkdir(path.join(inboundDir, name));
    await plant(outboundDir, outboundNames);

    const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    const conn = sweepingConnection(adapter);
    try {
      await openSplitScope(srv, conn, inbound, outbound);
      beginWindow(srv);
      const refusal = await withCapturedLogs(
        async () => conn.synchronize(),
        () => true,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(Error);
      const reported = (refusal as Error).message;
      expect(reported).toContain(
        `failed to delete ${UNDELETABLE_ENTRIES} of ${SPLIT_SCOPE_FAN_WIDTH}`,
      );
      for (const name of undeletable) expect(reported).toContain(name);
      // Every delete was attempted despite the failures: only the undeletable
      // entries survive, on both sides of the split scope.
      expect(fanViolations(srv, SPLIT_SCOPE_FAN_WIDTH)).toEqual([]);
      expect((await fsp.readdir(inboundDir)).sort()).toEqual(
        [...undeletable].sort(),
      );
      expect(await fsp.readdir(outboundDir)).toEqual([]);
    } finally {
      await conn.close().catch(() => {});
      await fsp.rm(inboundDir, { recursive: true, force: true });
      await fsp.rm(outboundDir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  `connection cleanup fans ${MAX_DIRECTORY_ENTRIES} deletes on one channel`,
  async () => {
    // The one fan with no cap of its own: cleanup() sweeps every name the
    // connection recorded as its own write. Nothing caps that set directly --
    // what stands under it is the refusal a party's own poll listing would
    // already have made -- so it is driven at that listing bound, which is the
    // resource envelope rather than a width an exchange produces.
    const srv = await startInProcessSftpServer();
    const party = await connectParty(srv);
    try {
      const names = protocolLeftoverNames("c", MAX_DIRECTORY_ENTRIES);
      await plant(party.localDir, names);
      const responsibleFiles = (
        party.conn as unknown as { responsibleFiles: Set<string> }
      ).responsibleFiles;
      for (const name of names) responsibleFiles.add(name);

      beginWindow(srv);
      await withCapturedLogs(
        async () => party.conn.cleanup(),
        () => true,
      );

      expect(fanViolations(srv, MAX_DIRECTORY_ENTRIES)).toEqual([]);
      expect(await fsp.readdir(party.localDir)).toEqual([]);
    } finally {
      await party.stop();
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "connection cleanup after a driven exchange fans a handful of deletes",
  async () => {
    // What that same fan is at the other end of its range: a real two-party
    // exchange, whose sender is left holding one unconsumed message when the
    // receiver stops polling. The delete-mode send gate and the per-poll pruning
    // together keep the recorded set to a handful, so the envelope above is
    // headroom rather than a width a run approaches.
    const srv = await startInProcessSftpServer();
    srv.inject.readdirBatchSize = SERVER_READDIR_BATCH;
    const localDir = await fsp.mkdtemp(
      path.join(srv.handle.backingDir, "exchange-"),
    );
    const remote = `${srv.handle.remoteRoot}/${path.basename(localDir)}`;
    const senderAdapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    const receiverAdapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    const sender = new FileSyncConnection(senderAdapter, {
      verbose: -1,
      pollingFrequency: 25,
    });
    const receiver = new FileSyncConnection(receiverAdapter, {
      verbose: -1,
      pollingFrequency: 25,
    });
    const delivered: unknown[] = [];
    const failures: unknown[] = [];
    sender.on("error", (error: unknown) => failures.push(error));
    receiver.on("error", (error: unknown) => failures.push(error));
    receiver.on("data", (message: unknown) => delivered.push(message));
    const responsibleFiles = (
      sender as unknown as { responsibleFiles: Set<string> }
    ).responsibleFiles;
    try {
      await withCapturedLogs(
        async () => {
          for (const [conn, cred] of [
            [sender, srv.handle.usera],
            [receiver, srv.handle.userb],
          ] as const)
            await conn.open({
              channel: "sftp",
              server: {
                host: srv.handle.host,
                port: srv.handle.port,
                ...serverAuth(cred),
                path: remote,
              },
            });
          await Promise.all([sender.synchronize(), receiver.synchronize()]);
          receiver.start();
          for (let index = 0; index < EXCHANGE_MESSAGES; index += 1)
            await sender.send({ message: index });
          await waitFor(async () => {
            const present = new Set(await fsp.readdir(localDir));
            return (
              delivered.length === EXCHANGE_MESSAGES &&
              ![...responsibleFiles].some((name) => present.has(name))
            );
          }, "the receiver to consume every message the sender wrote");
          receiver.stop();
          await receiver.close();
          // Written with the receiver gone, so it is still on the server -- and
          // so still the sender's responsibility -- when cleanup() runs.
          await sender.send({ message: EXCHANGE_MESSAGES });
        },
        () => true,
      );
      const width = responsibleFiles.size;
      const recorded = [...responsibleFiles];

      beginWindow(srv);
      await withCapturedLogs(
        async () => sender.cleanup(),
        () => true,
      );

      expect(failures).toEqual([]);
      expect(delivered).toHaveLength(EXCHANGE_MESSAGES);
      // A run that recorded nothing would pass every line below on silence.
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(EXCHANGE_CLEANUP_FAN_CEILING);
      expect(deletesReceived(srv)).toBe(width);
      const left = await fsp.readdir(localDir);
      expect(left.filter((name) => recorded.includes(name))).toEqual([]);
    } finally {
      receiver.stop();
      await sender.close().catch(() => {});
      await receiver.close().catch(() => {});
      await fsp.rm(localDir, { recursive: true, force: true });
      await srv.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
