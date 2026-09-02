import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";
import { redactAndSanitizeForDisplay } from "@psilink/core";

import {
  MAX_DEFERRED_CLEANUP_DELETES,
  MAX_DEFERRED_CLEANUP_REISSUES,
  DeferredCleanupDeletes,
} from "../../src/connection/sftpDeferredCleanup";

// The ceiling on the whole re-issue drain, duplicated from the module for the
// same reason the adapter's own liveness bounds are duplicated in its suite (it
// is a liveness backstop, not a seam), so the cases below can sit either side of
// it.
const DRAIN_BOUND_MS = 5_000;

// A remote path naming the protocol's own in-flight write, temp-<uuidv4()>.tmp:
// one of only two shapes the record admits, so a case about the record must use
// a real one rather than a readable stand-in. randomUUID() emits the same
// canonical lowercase v4 form uuidv4() does in send()/writeAck().
const protocolTempPath = (dir = "/remote"): string =>
  `${dir}/temp-${randomUUID()}.tmp`;

// A remote path whose DIRECTORY carries bytes no operator's terminal may see
// raw: an ESC that would drive an ANSI sequence and a CRLF that would spoof a
// second log line. The basename is a real temp, so the record admits it and the
// debug lines below render it -- which is what makes this the shape that pins
// the escape.
const spoofingTempPath = (): string =>
  protocolTempPath(
    `/remote/${String.fromCharCode(27)}[31mspoof${String.fromCharCode(13, 10)}`,
  );

interface Harness {
  record: DeferredCleanupDeletes;
  issued: string[];
  debug: string[];
}

// A record wired to a stub issuer and a capturing logger. `issue` decides what
// each re-issue does; the default performs it.
const makeRecord = (options?: {
  enabled?: boolean;
  canDrain?: () => boolean;
  issue?: (path: string) => Promise<void>;
}): Harness => {
  const issued: string[] = [];
  const debug: string[] = [];
  const record = new DeferredCleanupDeletes({
    enabled: options?.enabled ?? true,
    log: { debug: (message: string) => debug.push(message) },
    issueDelete: (path: string) => {
      issued.push(path);
      return options?.issue?.(path) ?? Promise.resolve();
    },
    canDrain: options?.canDrain ?? (() => true),
  });
  return { record, issued, debug };
};

const recordedPaths = (record: DeferredCleanupDeletes): string[] => [
  ...record.recorded.keys(),
];

const recordedBudgets = (record: DeferredCleanupDeletes): number[] => [
  ...record.recorded.values(),
];

// Let every queued continuation run, so anything an in-flight drain was going to
// issue has reached the stub issuer by the time the assertion reads it.
const settleQueue = async (turns = 10): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("what the record admits", () => {
  test("admits only the protocol's own in-flight temp shapes", () => {
    // safeDelete is a public transport method core calls with the shared
    // rendezvous lock path and with names read back from a listing of the
    // directory the PEER writes into, not just with this party's own temp. A
    // record is keyed on a PATH and re-issued at an arbitrary later point, so
    // admitting one of those would let a transiently-failed delete remove
    // whatever has since come to occupy that name. The temp shape's per-file v4
    // UUID is what makes deferral sound, so it is the only shape admitted.
    const { record } = makeRecord();

    const refused = [
      // The shared lock path, and the peer-written names an entry sweep reads
      // out of a directory listing.
      "/remote/peerA-peerB-lock.json",
      "/remote/peerB-abort.json",
      "/remote/peerB-hello.json",
      "/remote/peerB-1700000000-001-42.json",
      // A foreign temp whose stem is not a v4 UUID.
      "/remote/temp-export.tmp",
      // A valid v4 UUID in the uppercase form uuidv4() never emits.
      `/remote/temp-${randomUUID().toUpperCase()}.tmp`,
      // The temp shape as a DIRECTORY component rather than the file being
      // deleted: the basename is what decides.
      `/remote/temp-${randomUUID()}.tmp/peerB-abort.json`,
    ];
    for (const path of refused) record.record(path);
    expect(recordedPaths(record)).toEqual([]);

    // Both admitted shapes: the message/ack temp, and the hello publish's own.
    const ownTemp = protocolTempPath();
    const helloTemp = `/remote/temp-hello-${randomUUID()}.tmp`;
    record.record(ownTemp);
    record.record(helloTemp);
    expect(recordedPaths(record)).toEqual([ownTemp, helloTemp]);
  });

  test("records nothing when connection-per-poll is off", () => {
    // The record and the drain are that mode's machinery: the default mode holds
    // one session for the whole exchange, so a cleanup delete never lands in a
    // gap with no session.
    const { record, debug } = makeRecord({ enabled: false });

    record.record(protocolTempPath());

    expect(recordedPaths(record)).toEqual([]);
    expect(debug).toEqual([]);
  });

  test("a backslash in a remote name is not read as a path separator", () => {
    // SFTP paths are POSIX-separated on the wire whatever either end's platform
    // is, so a Windows-looking name is one segment here: reading the backslash
    // as a separator would admit a path whose real basename is not a temp.
    const { record } = makeRecord();

    record.record(`/remote/dir\\temp-${randomUUID()}.tmp`);

    expect(recordedPaths(record)).toEqual([]);
  });
});

describe("what bounds the record", () => {
  test("caps the record, refusing the newcomer rather than evicting", () => {
    // Overflow refuses the new record rather than evicting an older one:
    // refusing degrades the overflowing cleanup to exactly the behavior it had
    // before the record existed, while evicting would turn a cleanup this
    // adapter had already promised to re-issue into a silent loss.
    const { record, debug } = makeRecord();
    const first = protocolTempPath();

    record.record(first);
    for (let entry = 1; entry < MAX_DEFERRED_CLEANUP_DELETES; entry += 1)
      record.record(protocolTempPath());
    expect(record.recorded.size).toBe(MAX_DEFERRED_CLEANUP_DELETES);
    expect(debug).toEqual([]);

    const overflowing = spoofingTempPath();
    record.record(overflowing);

    expect(record.recorded.size).toBe(MAX_DEFERRED_CLEANUP_DELETES);
    expect(recordedPaths(record)[0]).toBe(first);
    expect(recordedPaths(record)).not.toContain(overflowing);
    // The refusal is reported where an operator looking for it would find it,
    // says which file was left behind, and renders the path through the display
    // escape rather than raw.
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain("cleanup deletes are already recorded");
    expect(debug[0]).toContain("is left behind");
    expect(debug[0]).toContain(
      String(redactAndSanitizeForDisplay(overflowing)),
    );
    expect(debug[0]).not.toContain(String.fromCharCode(27));
    expect(/[\r\n]/.test(debug[0])).toBe(false);
  });

  test("gives up on a recording whose re-issue budget is spent", () => {
    // Without the budget the only thing that ever clears a record is a delete
    // this side saw succeed, so a delete that can NEVER succeed is retried at
    // every re-establishment for the life of the exchange.
    const { record, debug } = makeRecord();
    const spent = spoofingTempPath();

    record.record(spent, 0);

    expect(recordedPaths(record)).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain(
      `re-issued ${MAX_DEFERRED_CLEANUP_REISSUES} times`,
    );
    expect(debug[0]).toContain("is left behind");
    expect(debug[0]).toContain(String(redactAndSanitizeForDisplay(spent)));
    expect(debug[0]).not.toContain(String.fromCharCode(27));
    expect(/[\r\n]/.test(debug[0])).toBe(false);
  });

  test("an entry already standing keeps the budget it holds", () => {
    // The decrement a failing re-issue writes belongs to the recording it ran
    // for. A path re-recorded while that re-issue is still in flight is a fresh
    // recording with the whole budget, and the decrement must not be applied to
    // it.
    const { record } = makeRecord();
    const path = protocolTempPath();

    record.record(path);
    record.record(path, 1);

    expect(recordedBudgets(record)).toEqual([MAX_DEFERRED_CLEANUP_REISSUES]);
  });

  test("a re-issue that fails offers its path back with one fewer left", async () => {
    // A server briefly unreachable at one boundary is swept at the next, against
    // a bounded per-recording budget rather than for the life of the run.
    const { record, issued } = makeRecord({
      issue: () => Promise.reject(new Error("permission denied")),
    });
    const refused = protocolTempPath();
    record.record(refused);

    await expect(record.drain()).resolves.toBeUndefined();

    expect(issued).toEqual([refused]);
    expect(recordedPaths(record)).toEqual([refused]);
    expect(recordedBudgets(record)).toEqual([
      MAX_DEFERRED_CLEANUP_REISSUES - 1,
    ]);
  });

  test("a decrement from an in-flight re-issue is discarded once its path stands again", async () => {
    // The two halves together: the drain's snapshot leaves the record clear, the
    // path is offered again while its own re-issue is still on the wire, and the
    // failure that follows must not spend the fresh recording's budget.
    let failIssue!: () => void;
    const parked = new Promise<void>((_, reject) => {
      failIssue = () => reject(new Error("permission denied"));
    });
    const { record } = makeRecord({ issue: () => parked });
    const path = protocolTempPath();
    record.record(path);

    const draining = record.drain();
    await settleQueue();
    expect(recordedPaths(record)).toEqual([]);

    record.record(path);
    expect(recordedBudgets(record)).toEqual([MAX_DEFERRED_CLEANUP_REISSUES]);

    failIssue();
    await expect(draining).resolves.toBeUndefined();

    expect(recordedPaths(record)).toEqual([path]);
    expect(recordedBudgets(record)).toEqual([MAX_DEFERRED_CLEANUP_REISSUES]);
  });

  test("a re-record refused by the full cap is not kept either", async () => {
    // What the drain guarantees is that a path it could not perform is OFFERED
    // BACK, not that it is always kept: a re-record runs through the same capped
    // path a first record does.
    const { record } = makeRecord({
      issue: () => {
        // The record is refilled to its cap while this re-issue is outstanding,
        // so the path it offers back arrives at a full record.
        for (let entry = 0; entry < MAX_DEFERRED_CLEANUP_DELETES; entry += 1)
          record.record(protocolTempPath());
        return Promise.reject(new Error("permission denied"));
      },
    });
    const refused = protocolTempPath();
    record.record(refused);

    await expect(record.drain()).resolves.toBeUndefined();

    expect(record.recorded.size).toBe(MAX_DEFERRED_CLEANUP_DELETES);
    expect(recordedPaths(record)).not.toContain(refused);
  });
});

describe("the drain", () => {
  test("costs no round trip and asks nothing of the transport when the record is empty", async () => {
    // The mode's healthy path. It is also why the transport is consulted second:
    // an empty record is answered without reading a session state at all.
    const canDrain = vi.fn(() => true);
    const { record, issued } = makeRecord({ canDrain });

    await expect(record.drain()).resolves.toBeUndefined();

    expect(issued).toEqual([]);
    expect(canDrain).not.toHaveBeenCalled();
  });

  test("keeps the record when the transport says it cannot drain", async () => {
    // A fatal SFTP protocol error, a latched teardown, and no live session all
    // reach the record as one refusal: it keeps for the next re-establishment
    // rather than issuing onto a session that cannot carry it.
    const { record, issued } = makeRecord({ canDrain: () => false });
    const kept = protocolTempPath();
    record.record(kept);

    await expect(record.drain()).resolves.toBeUndefined();

    expect(issued).toEqual([]);
    expect(recordedPaths(record)).toEqual([kept]);
  });

  test("a second drain joins the first, and a record made after its snapshot waits for the next", async () => {
    // Re-establishment is not serialized: the poll cycle's re-dial, teardown's,
    // and the recovery gate's all reach it. The second must JOIN the drain
    // already running rather than start one -- issuing a second delete for a
    // path whose first re-issue is still on the wire, and taking a fresh
    // snapshot that sweeps a record the first drain has not finished paying for.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { record, issued } = makeRecord({ issue: () => held });
    const first = protocolTempPath();
    const second = protocolTempPath();
    record.record(first);
    record.record(second);

    const draining = record.drain();
    await settleQueue();
    expect(issued).toEqual([first, second]);

    // A cleanup recorded while that drain is still outstanding, and a second
    // re-establishment behind it.
    const late = protocolTempPath();
    record.record(late);
    const joining = record.drain();
    expect(joining).toBe(draining);

    release();
    await expect(draining).resolves.toBeUndefined();
    await expect(joining).resolves.toBeUndefined();

    // The late record was left for the next re-establishment rather than issued
    // alongside the snapshot.
    expect(issued).toEqual([first, second]);
    expect(recordedPaths(record)).toEqual([late]);

    await expect(record.drain()).resolves.toBeUndefined();
    expect(issued).toEqual([first, second, late]);
  });

  test("holds each re-issue to the drain bound and keeps what it could not perform", async () => {
    // Core forwards ensureConnected unwrapped and close() awaits it with no
    // budget above, so the drain's wait lands on teardown and on the recovery
    // gate's first attempt after an idle gap. A partner that ACCEPTS delete
    // requests and WITHHOLDS their callbacks must therefore not cost either of
    // them a whole per-operation deadline. The re-issues go out concurrently, so
    // a record at its cap ends at the same bound one entry does.
    vi.useFakeTimers();
    try {
      const { record, issued } = makeRecord({
        issue: () => new Promise<void>(() => {}),
      });
      for (let entry = 0; entry < MAX_DEFERRED_CLEANUP_DELETES; entry += 1)
        record.record(protocolTempPath());

      let settled = false;
      const draining = record.drain().then(() => {
        settled = true;
      });
      const assertion = expect(draining).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS - 1);
      expect(issued).toHaveLength(MAX_DEFERRED_CLEANUP_DELETES);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
      expect(settled).toBe(true);

      // Cutting a re-issue short loses nothing real: the expiry is a rejection
      // like any other, so every path is offered back for the next
      // re-establishment.
      expect(record.recorded.size).toBe(MAX_DEFERRED_CLEANUP_DELETES);
      expect(recordedBudgets(record)).toEqual(
        Array.from(
          { length: MAX_DEFERRED_CLEANUP_DELETES },
          () => MAX_DEFERRED_CLEANUP_REISSUES - 1,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("resolves whatever a re-issue does, so a cleanup sweep can never fail an exchange", async () => {
    // Core's poll loop treats an ensureConnected rejection as a TERMINAL dial
    // error, and the drain hangs off ensureConnected: a best-effort cleanup
    // sweep must not be able to end an exchange, however its re-issues settle.
    const outcomes = [
      () => Promise.resolve(),
      () => Promise.reject(new Error("permission denied")),
      () => Promise.reject("a rejection that is not an Error"),
    ];
    let issue = 0;
    const { record } = makeRecord({
      issue: () => outcomes[issue++ % outcomes.length](),
    });
    for (let entry = 0; entry < outcomes.length; entry += 1)
      record.record(protocolTempPath());

    await expect(record.drain()).resolves.toBeUndefined();
    // And again, over the paths the first drain offered back.
    await expect(record.drain()).resolves.toBeUndefined();
  });
});
