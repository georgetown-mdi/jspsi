// The cleanup deletes an idle release leaves for the next re-establishment.

import { describe, expect, test, vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { MAX_DEFERRED_CLEANUP_REISSUES } from "../../src/connection/sftpDeferredCleanup";
import { SftpAdapterLedger } from "../../src/connection/sftpAdapterLedger";
import {
  adapterLog,
  captureAdapterLog,
  deferredCleanupBudgets,
  deferredCleanupPaths,
  ephemeralClient,
  fatalErrorWrapper,
  installClient,
  notConnected,
  protocolTempPath,
  releaseBoundaryStands,
  slowClosingClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

describe("deferred cleanup deletes across an idle release", () => {
  // The never-reject cleanup delete reaches no gate at all: its contract keeps it
  // outside the recovery chokepoint, so it is the one operation that can be issued
  // into an idle gap and reach no session. It resolves either way, so its caller
  // in core cannot tell that from a delete that landed -- only the adapter can,
  // and what it does with the reading is record the cleanup and re-issue it at the
  // next point a session exists.

  // Wait for a condition the adapter reaches on its own schedule (a request
  // arriving at the fixture), failing rather than hanging if it never does.
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 2_000 && !predicate(); turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(predicate()).toBe(true);
  };

  test("a cleanup delete issued while the deliberate-release boundary stands is re-issued at the next re-establishment", async () => {
    const { client, state, deleted } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);

    // The send()-catch sweep resuming into the idle gap: it must not reject, and
    // on the released session it removes nothing.
    const abandoned = protocolTempPath();
    await expect(adapter.safeDelete(abandoned)).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
    expect(deferredCleanupPaths(adapter)).toEqual([abandoned]);

    // The next cycle's re-establishment is where the file actually goes away.
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(deleted).toEqual([abandoned]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
  });

  test("a cleanup delete issued while the release is in flight is re-issued at the next re-establishment", async () => {
    // The other reading, and the one no completed-boundary check covers: the
    // release has driven the ssh2 Client's end() and is awaiting its 'close', so
    // the session still reads live over a transport that can no longer send the
    // delete.
    const { client, rawClient, deleted } = slowClosingClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const release = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(client.sftp).not.toBeNull();

    const inFlight = protocolTempPath();
    await expect(adapter.safeDelete(inFlight)).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
    await release;

    await expect(adapter.ensureConnected()).resolves.toBe(true);
    expect(deleted).toEqual([inFlight]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
  });

  test("a cleanup delete that can obtain no session at all resolves and keeps its record", async () => {
    // The dial keeps failing, so the drain never runs. The contract still holds --
    // the caller in a catch block sees no rejection -- and the record is kept
    // rather than dropped, so the first re-establishment that does land sweeps it.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    connect.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const orphan = protocolTempPath();
    await expect(adapter.safeDelete(orphan)).resolves.toBeUndefined();
    await expect(adapter.ensureConnected()).resolves.toBe(false);

    expect(deferredCleanupPaths(adapter)).toEqual([orphan]);
  });

  test("an idle boundary reached with a drain re-issue in flight still closes the session", async () => {
    // The re-issue is the one round trip still owing a settlement that an idle
    // release MAY tear, and this is what that buys. Counted at the bracket
    // instead, it would hold the boundary for its whole bound -- and a boundary
    // that closes nothing leaves the session live, so the next re-establishment
    // finds one, re-runs the drain and regenerates the operation, which against
    // a server that accepts DELETE and withholds its callback reverts the mode
    // to a held session for the run. The tear costs the cleanup nothing: the
    // torn delete rejects, which records the path again for the next
    // re-establishment.
    const { client, state } = ephemeralClient(wrapperMethods());
    const calls: string[] = [];
    let releaseDelete!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    client.delete = vi.fn(async (path: string) => {
      calls.push(path);
      // The sweep that fell into the idle gap; the re-issue behind it is the one
      // held on the wire.
      if (calls.length === 1) throw notConnected("delete");
      await parked;
      if (!state.live) throw notConnected("delete");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const withheld = protocolTempPath();
    await expect(adapter.safeDelete(withheld)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);

    const reestablishing = adapter.ensureConnected();
    await waitUntil(() => calls.length === 2);
    expect(state.live).toBe(true);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((adapter as any).ledger as SftpAdapterLedger).outstandingOperations,
    ).toBe(0);

    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(adapter.heldBoundaryCount).toBe(0);

    releaseDelete();
    expect(await reestablishing).toBe(true);
    // The torn re-issue spent one of its budget and left the rest, so the next
    // re-establishment sweeps the path again.
    expect(deferredCleanupPaths(adapter)).toEqual([withheld]);
    expect(deferredCleanupBudgets(adapter)).toEqual([
      MAX_DEFERRED_CLEANUP_REISSUES - 1,
    ]);
  });

  test("a drain rejection cannot fail the exchange, while the dial's host-key rejection still does", async () => {
    // Core's poll loop treats an ensureConnected rejection as a TERMINAL dial
    // error: it stops the poller and emits. The two things that can reject here
    // must therefore part company -- a best-effort cleanup sweep may not end an
    // exchange, and a host-key rejection must, since papering that over would
    // turn a possible MITM into a silently-continued run.
    const { client, connect, deleted } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const recorded = protocolTempPath();
    await adapter.safeDelete(recorded);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);

    const cleanupRecord = (
      adapter as unknown as {
        deferredCleanupDeletes: { drain: () => Promise<void> };
      }
    ).deferredCleanupDeletes;
    const drain = cleanupRecord.drain;
    cleanupRecord.drain = () => Promise.reject(new Error("the sweep blew up"));
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    cleanupRecord.drain = drain;

    // With the real drain restored and the record still standing, a fatal
    // host-key rejection reaches the caller and nothing is swept onto the
    // session that failed verification.
    await adapter.releaseForIdle();
    connect.mockRejectedValue(new Error("Host denied (verification failed)"));
    await expect(adapter.ensureConnected()).rejects.toThrow(
      "Host denied (verification failed)",
    );
    expect(deleted).toEqual([]);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);
  });

  test("after a fatal SFTP error a cleanup delete short-circuits and no recorded one is re-issued", async () => {
    // Both halves of the post-fatal posture. A request posted to a destroyed
    // wrapper never calls back, so safeDelete returns at once rather than driving
    // one -- and the drain must not reintroduce, at teardown, exactly the request
    // that short-circuit refuses.
    const wrapper = fatalErrorWrapper();
    const { client } = ephemeralClient(wrapper);
    const attempted: string[] = [];
    client.delete = vi.fn(async (path: string) => {
      attempted.push(path);
      // A cleanup that fails for its own reason, so it is recorded without a
      // release having taken the session away.
      throw new Error("permission denied");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // A cleanup that failed for its own reason, recorded before anything went
    // fatal.
    const recorded = protocolTempPath();
    await expect(adapter.safeDelete(recorded)).resolves.toBeUndefined();
    expect(attempted).toEqual([recorded]);
    expect(deferredCleanupPaths(adapter)).toEqual([recorded]);

    wrapper.emit("error", new Error("Malformed NAME packet"));

    await expect(
      adapter.safeDelete(protocolTempPath()),
    ).resolves.toBeUndefined();
    adapter.beginTeardown();
    await adapter.ensureConnected();

    // Nothing further reached the dead session, from either route.
    expect(attempted).toEqual([recorded]);
  });

  test("a cleanup delete the server keeps refusing is re-issued a bounded number of times, then given up on", async () => {
    // The only thing that clears a record is a delete this side saw succeed, so
    // without a budget a delete that can never succeed -- a peer-owned temp under
    // a sticky-bit directory, which the entry sweep still attempts -- is re-issued
    // once per re-establishment for the life of the exchange, and with the record
    // full that is a record's worth of extra round trips per poll cycle against
    // the partner's server.
    const { client, state } = ephemeralClient(wrapperMethods());
    const attempts: string[] = [];
    client.delete = vi.fn(async (path: string) => {
      attempts.push(path);
      if (!state.live) throw notConnected("delete");
      throw new Error("permission denied");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const debug = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug,
      trace: vi.fn(),
      error: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    const refused = protocolTempPath();
    await expect(adapter.safeDelete(refused)).resolves.toBeUndefined();
    expect(deferredCleanupBudgets(adapter)).toEqual([
      MAX_DEFERRED_CLEANUP_REISSUES,
    ]);

    // Each re-establishment spends one of the budget and re-records the rest, so
    // the record narrows toward giving up rather than standing for the run.
    for (let spent = 1; spent <= MAX_DEFERRED_CLEANUP_REISSUES; spent += 1) {
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      await adapter.releaseForIdle();
      expect(deferredCleanupBudgets(adapter)).toEqual(
        spent === MAX_DEFERRED_CLEANUP_REISSUES
          ? []
          : [MAX_DEFERRED_CLEANUP_REISSUES - spent],
      );
    }

    // One attempt for the sweep that reached no session, then the budget, and
    // then nothing however many further cycles run.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await expect(adapter.ensureConnected()).resolves.toBe(true);
      await adapter.releaseForIdle();
    }
    expect(attempts).toHaveLength(1 + MAX_DEFERRED_CLEANUP_REISSUES);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
    // Giving up says so, and says which file was left behind.
    expect(
      debug.mock.calls.some(
        (call) =>
          (call[0] as string).includes("without succeeding") &&
          (call[0] as string).includes("is left behind"),
      ),
    ).toBe(true);
  });

  test("an op re-establishing through the recovery gate drains the record before its own attempt", async () => {
    // The third route into the drain: the gate withSessionRecovery applies at
    // operation entry re-establishes through ensureConnected, so an ordinary
    // data-plane op sweeps the record with no cycle-start or teardown
    // re-establishment involved. The op behind it therefore waits the drain out
    // before its first attempt, which is bounded -- the re-issues go out
    // concurrently under one per-operation deadline, and the gate is best-effort
    // -- and it still completes in that one attempt.
    const { client, state, deleted } = ephemeralClient(wrapperMethods());
    const order: string[] = [];
    const performDelete = client.delete;
    client.delete = vi.fn(async (path: string) => {
      await performDelete(path);
      order.push("cleanup delete");
    });
    client.exists = vi.fn(async () => {
      order.push("exists attempt");
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.releaseForIdle();
    expect(state.live).toBe(false);
    expect(releaseBoundaryStands(adapter)).toBe(true);

    const gated = protocolTempPath();
    await expect(adapter.safeDelete(gated)).resolves.toBeUndefined();
    expect(deferredCleanupPaths(adapter)).toEqual([gated]);

    // No ensureConnected() of its own: the gate is the only route this op has to
    // a session, and so the only route the record has to the drain.
    await expect(adapter.exists("/remote/file.json")).resolves.toBe(true);

    expect(deleted).toEqual([gated]);
    expect(deferredCleanupPaths(adapter)).toEqual([]);
    expect(order).toEqual(["cleanup delete", "exists attempt"]);
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
  });
});
