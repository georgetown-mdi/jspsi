import type { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import nodeEvents from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { MAX_DIRECTORY_ENTRIES } from "../../src/connection/listingGuard";
import {
  MAX_DEFERRED_CLEANUP_DELETES,
  SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS,
  SSH2SFTPClientAdapter,
} from "../../src/connection/ssh2SftpAdapter";
import { selectedBackend } from "../sftpServer";
import { serverAuth, sftpServer } from "../sftpServer/testContext";

// ssh2-sftp-client brackets every operation it issues with one 'end', one
// 'close' and one 'error' listener on the ONE ssh2 Client the adapter holds for
// its whole life, removing the three when that operation settles. Concurrent
// operations therefore stack listeners linearly, and the fans this transport
// really issues -- core's per-entry sweeps of a directory listing, and the
// connection-per-poll cleanup drain's re-issue -- run far past Node's default
// ceiling of 10. The adapter raises that ceiling at construction to
// SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS; the cases here hold the two halves of
// what that is only acceptable under.
//
// One: an operator never sees the MaxListenersExceededWarning the fan used to
// print. Node emits it through process.emitWarning rather than console, so it
// lands on stderr past the project logger, past every verbosity control, and
// past this suite's console sentinel -- process.on("warning") is the only seam
// that sees it, and it is what these cases watch.
//
// Two: raising the ceiling does not blind the run to growth that is genuinely
// unbounded. The ceiling never could tell a bounded fan from a leak (it fires at
// most once per emitter and event name and says nothing about whether the
// listeners came off), so the accounting is pinned directly instead: the peak is
// the fan's width above the persistent listeners, and once the fan settles the
// count is EXACTLY those persistent listeners again on every event name. The
// leaking-shape case drives that same check red, since a check nobody has seen
// fail is not evidence.
//
// Only the in-process backend can be reached this way (see
// test/sftpServer/types.ts), so these run there.
const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

const TEST_TIMEOUT_MS = 240_000;

const srv = sftpServer();

// Widths driven against the ceiling: the one at which the default of 10 was
// first crossed, a fan the size of core's real sweeps, and the widest this
// transport has been driven to at all.
const FAN_WIDTHS = [9, 40, 512] as const;

// The leaking shape's width. Well under the raised ceiling, so its leak provokes
// no warning at all -- which is the point: the accounting, not the ceiling, is
// what catches it.
const LEAK_WIDTH = 40;

// Cleanup records attempted against MAX_DEFERRED_CLEANUP_DELETES, so the drain
// fans out at the cap itself rather than at whatever a smaller number reached.
const DRAIN_RECORDS_ATTEMPTED = MAX_DEFERRED_CLEANUP_DELETES + 6;

// The event names ssh2-sftp-client's per-operation trio occupies.
const BRACKETED_EVENTS = ["end", "close", "error"] as const;

// ---------------------------------------------------------------------------
// Listener accounting on the shared ssh2 Client.
// ---------------------------------------------------------------------------

type Counts = Record<string, number>;

interface Probe {
  emitter: EventEmitter;
  /** Peak listener count per event name, sampled on every add and remove. */
  peaks: Counts;
  /** Listener count per event name when the probe was installed or reset. */
  baseline: Counts;
  now: () => Counts;
  reset: () => void;
}

// The ssh2 Client ssh2-sftp-client constructs once and reuses across every dial,
// reached through the adapter's own client field the way the listener-accounting
// case in sftpConnection.test.ts reaches it.
function sharedClient(adapter: SSH2SFTPClientAdapter): EventEmitter {
  return (adapter as unknown as { client: { client: EventEmitter } }).client
    .client;
}

const MUTATORS = [
  "on",
  "addListener",
  "once",
  "prependListener",
  "prependOnceListener",
  "removeListener",
  "off",
  "removeAllListeners",
] as const;

function counts(emitter: EventEmitter): Counts {
  const out: Counts = {};
  for (const name of emitter.eventNames()) {
    const count = emitter.listenerCount(name);
    if (count > 0) out[String(name)] = count;
  }
  return out;
}

// Wraps the emitter's own add and remove methods so the peak is sampled at the
// instant a listener is attached. Polling cannot substitute: a fan settles
// through a microtask cascade that never yields to a timer, so a poll misses the
// peak entirely and would report a leak-free run for any shape at all.
function probeListeners(adapter: SSH2SFTPClientAdapter): Probe {
  const emitter = sharedClient(adapter);
  const sample = () => {
    for (const [name, count] of Object.entries(counts(emitter)))
      if (count > (probe.peaks[name] ?? 0)) probe.peaks[name] = count;
  };
  const probe: Probe = {
    emitter,
    peaks: counts(emitter),
    baseline: counts(emitter),
    now: () => counts(emitter),
    reset: () => {
      probe.peaks = counts(emitter);
      probe.baseline = counts(emitter);
    },
  };
  for (const method of MUTATORS) {
    const mutable = emitter as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const original = mutable[method].bind(emitter);
    mutable[method] = (...args: unknown[]) => {
      const result = original(...args);
      sample();
      return result;
    };
  }
  return probe;
}

// Every way the per-operation accounting on a fan of `width` can be wrong, as
// messages rather than a bare boolean, so the leaking-shape case can name what it
// caught. The peak is held EXACTLY: too low means the fan never was concurrent
// and the run proved nothing, too high means something attached a listener the
// trio does not account for.
function accountingViolations(probe: Probe, width: number): string[] {
  const violations: string[] = [];
  const settled = probe.now();
  for (const event of BRACKETED_EVENTS) {
    const expected = (probe.baseline[event] ?? 0) + width;
    const peak = probe.peaks[event] ?? 0;
    if (peak !== expected)
      violations.push(
        `peak '${event}' listeners were ${peak}, expected ${expected}`,
      );
  }
  for (const event of new Set([
    ...Object.keys(probe.baseline),
    ...Object.keys(settled),
  ]))
    if ((settled[event] ?? 0) !== (probe.baseline[event] ?? 0))
      violations.push(
        `'${event}' listeners settled at ${settled[event] ?? 0}, not back to ` +
          `the pre-fan ${probe.baseline[event] ?? 0}`,
      );
  return violations;
}

// ---------------------------------------------------------------------------
// The warning seam. Node routes MaxListenersExceededWarning through
// process.emitWarning, which neither the console sentinel nor withCapturedLogs
// can observe.
// ---------------------------------------------------------------------------

interface WarningWatch {
  seen: string[];
  stop: () => void;
}

function watchForListenerWarnings(): WarningWatch {
  const seen: string[] = [];
  const handler = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning")
      seen.push(warning.message);
  };
  process.on("warning", handler);
  return { seen, stop: () => void process.off("warning", handler) };
}

// process.emitWarning defers the emission, so a fan's warning lands a turn or
// more after the fan itself has settled.
async function letWarningsLand(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// One connected party, constructed as apps/cli/src/protocol.ts constructs the
// adapter: no stallDeadlineMs seam, and no listener ceiling raised by the test.
// ---------------------------------------------------------------------------

interface Party {
  adapter: SSH2SFTPClientAdapter;
  conn: FileSyncConnection;
  probe: Probe;
  remote: string;
  localDir: string;
  stop: () => Promise<void>;
}

async function connectParty(
  options: { ephemeralSessions?: boolean } = {},
): Promise<Party> {
  let allocatedDir: string | undefined;
  let openedConn: FileSyncConnection | undefined;
  try {
    const localDir = await fsp.mkdtemp(path.join(srv.backingDir, "ceiling-"));
    allocatedDir = localDir;
    const remote = `${srv.remoteRoot}/${path.basename(localDir)}`;
    const adapter = new SSH2SFTPClientAdapter({
      verbosity: -1,
      ephemeralSessions: options.ephemeralSessions ?? false,
    });
    const conn = new FileSyncConnection(adapter, {
      verbose: -1,
      pollingFrequency: 10,
    });
    openedConn = conn;
    conn.on("error", () => {});
    await conn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: remote,
      },
      options: { maxReconnectAttempts: 4 },
    });
    // Installed after the dial, so the baseline is the persistent set a
    // connected client carries rather than a fresh construction's.
    const probe = probeListeners(adapter);
    return {
      adapter,
      conn,
      probe,
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

// `width` files for a delete fan to be aimed at, named off `prefix` so
// successive fans in one case cannot collide.
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

// The shape core's rendezvous entry sweep and connection cleanup both issue: one
// never-reject delete per file, fanned out in a single turn.
async function fanSafeDelete(party: Party, targets: string[]): Promise<void> {
  await withCapturedLogs(
    async () =>
      Promise.all(targets.map((target) => party.adapter.safeDelete(target))),
    () => true,
  );
  await letWarningsLand();
}

// ---------------------------------------------------------------------------

inProcessOnly(
  "the derived ceiling is seated on the shared client and clears every fan bound",
  async () => {
    const adapter = new SSH2SFTPClientAdapter({ verbosity: -1 });
    expect(sharedClient(adapter).getMaxListeners()).toBe(
      SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS,
    );
    // A raise, not a lowering, and with room above each bound that admits a fan
    // onto this emitter -- the two terms the derivation is built from.
    expect(SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS).toBeGreaterThan(
      nodeEvents.defaultMaxListeners,
    );
    expect(SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS).toBeGreaterThan(
      MAX_DIRECTORY_ENTRIES,
    );
    expect(SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS).toBeGreaterThan(
      MAX_DEFERRED_CLEANUP_DELETES,
    );
  },
);

inProcessOnly(
  "one construction-time raise covers the operations of a re-dialed session",
  async () => {
    // Connection-per-poll releases the session at an idle boundary and the next
    // operation re-dials, which is a real second dial on the same adapter.
    const party = await connectParty({ ephemeralSessions: true });
    const watch = watchForListenerWarnings();
    try {
      const beforeRedial = party.probe.emitter;
      await withCapturedLogs(
        async () => {
          await party.adapter.releaseForIdle();
          await party.adapter.list(party.remote);
        },
        () => true,
      );

      // The emitter each operation attaches to is the one the constructor
      // raised, and the re-dial did not replace it.
      expect(sharedClient(party.adapter)).toBe(beforeRedial);
      expect(beforeRedial.getMaxListeners()).toBe(
        SHARED_SSH2_CLIENT_MAX_EVENT_LISTENERS,
      );

      party.probe.reset();
      const targets = await plantDeletables(party, "redialed", FAN_WIDTHS[0]);
      await fanSafeDelete(party, targets);

      // A fan issued after the re-dial lands on that same emitter -- the peak
      // moving is what proves it -- and still trips nothing.
      expect(accountingViolations(party.probe, FAN_WIDTHS[0])).toEqual([]);
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

for (const width of FAN_WIDTHS)
  inProcessOnly(
    `a concurrent fan of ${width} warns no operator and strands no listener`,
    async () => {
      // A fresh adapter per width: Node marks the warning per emitter and event
      // name, so a width sharing an emitter with an earlier one could pass on
      // the earlier one's suppression rather than on the ceiling.
      const party = await connectParty();
      const watch = watchForListenerWarnings();
      try {
        // The width really is one the default ceiling refused -- otherwise the
        // silence below would be silence about nothing.
        for (const event of ["end", "close"] as const)
          expect((party.probe.baseline[event] ?? 0) + width).toBeGreaterThan(
            nodeEvents.defaultMaxListeners,
          );

        const targets = await plantDeletables(party, "fan", width);
        await fanSafeDelete(party, targets);

        expect(watch.seen).toEqual([]);
        expect(accountingViolations(party.probe, width)).toEqual([]);
        expect(
          (await fsp.readdir(party.localDir)).filter((name) =>
            name.startsWith("fan-"),
          ),
        ).toEqual([]);
      } finally {
        watch.stop();
        await party.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

inProcessOnly(
  "an operation-scoped listener that is never removed fails the accounting",
  async () => {
    // The red case for the check above: a shape where each operation attaches a
    // listener to the shared client and nothing takes it off, which is exactly
    // what the raised ceiling cannot be relied on to surface.
    const party = await connectParty();
    const watch = watchForListenerWarnings();
    try {
      const emitter = party.probe.emitter;
      const performDelete = party.adapter.safeDelete.bind(party.adapter);
      (
        party.adapter as unknown as {
          safeDelete: (target: string) => Promise<void>;
        }
      ).safeDelete = (target: string) => {
        emitter.on("end", () => {});
        return performDelete(target);
      };

      const targets = await plantDeletables(party, "leak", LEAK_WIDTH);
      await fanSafeDelete(party, targets);

      // The ceiling stays silent -- the leak is an order of magnitude below it,
      // which is why the accounting has to be what catches this.
      expect(watch.seen).toEqual([]);
      const violations = accountingViolations(party.probe, LEAK_WIDTH);
      expect(violations).toContainEqual(
        expect.stringContaining("peak 'end' listeners were"),
      );
      expect(violations).toContainEqual(
        expect.stringContaining("'end' listeners settled at"),
      );
      // Only the leaked name is reported: the trio the library itself attaches
      // came off on 'close' and 'error' exactly as it does with no leak, so the
      // check is discriminating rather than merely noisy.
      expect(
        violations.filter(
          (violation) =>
            violation.includes("'close'") || violation.includes("'error'"),
        ),
      ).toEqual([]);
    } finally {
      watch.stop();
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

inProcessOnly(
  "the cleanup drain's re-issue fan at its own cap warns nothing",
  async () => {
    const party = await connectParty({ ephemeralSessions: true });
    const watch = watchForListenerWarnings();
    try {
      const temps: string[] = [];
      for (let index = 0; index < DRAIN_RECORDS_ATTEMPTED; index += 1) {
        const name = `temp-${randomUUID()}.tmp`;
        await fsp.writeFile(path.join(party.localDir, name), "x");
        temps.push(`${party.remote}/${name}`);
      }
      const recorded = (
        party.adapter as unknown as {
          deferredCleanupDeletes: Map<string, number>;
        }
      ).deferredCleanupDeletes;

      await withCapturedLogs(
        async () => {
          // With the session released, every safeDelete below reaches no session
          // and records itself for the drain instead of deleting.
          await party.adapter.releaseForIdle();
          await Promise.all(
            temps.map((temp) => party.adapter.safeDelete(temp)),
          );
        },
        () => true,
      );
      expect(recorded.size).toBe(MAX_DEFERRED_CLEANUP_DELETES);

      party.probe.reset();
      await withCapturedLogs(
        async () => party.adapter.list(party.remote),
        () => true,
      );
      await letWarningsLand();

      expect(watch.seen).toEqual([]);
      expect(recorded.size).toBe(0);
      // The re-establishment that triggers the drain is a raw-wrapper listing, so
      // the whole trio count over the drain is the re-issue fan's own.
      expect(
        accountingViolations(party.probe, MAX_DEFERRED_CLEANUP_DELETES),
      ).toEqual([]);
      expect(
        (await fsp.readdir(party.localDir)).filter((name) =>
          name.startsWith("temp-"),
        ),
      ).toHaveLength(DRAIN_RECORDS_ATTEMPTED - MAX_DEFERRED_CLEANUP_DELETES);
    } finally {
      watch.stop();
      await party.stop();
    }
  },
  TEST_TIMEOUT_MS,
);
