// The lock every dial and every close runs under, and its bounded acquire.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";
import { TransportOperationStalledError } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { SFTP_REDIAL_WARN_INTERVAL } from "../../../src/connection/sftpAdapterLedger";
import { SFTP_HEARTBEAT_INTERVAL_MS } from "../../../src/connection/sftpHeartbeat";
import {
  adapterLog,
  captureAdapterLog,
  ephemeralClient,
  installClient,
  releasableClient,
  slowClosingClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

describe("session transitions", () => {
  // Every point at which the adapter dials a session or closes one runs under one
  // FIFO lock. These cases exercise the lock itself: the order transitions run
  // in, that none overlaps another, that teardown takes the queue like the rest,
  // and that a failing transition frees it.

  // Records each transition's body entering and leaving, through the adapter's own
  // acquire. Built test-side so the adapter holds no log of its own; an exact
  // start/end sequence is what proves both the order and the non-overlap.
  function recordTransitions(adapter: SSH2SFTPClientAdapter): string[] {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;
    const acquire = internals.runTransition.bind(adapter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    internals.runTransition = (transition: any) =>
      acquire({
        ...transition,
        run: async (recordBoundary: unknown) => {
          log.push(`start:${transition.kind}`);
          try {
            return await transition.run(recordBoundary);
          } finally {
            log.push(`end:${transition.kind}`);
          }
        },
      });
    return log;
  }

  test("all four non-teardown transitions started at once run one at a time in request order", async () => {
    // Teardown is not a fifth participant here by construction: it latches before
    // it enqueues, so anything already queued behind it is skipped rather than run
    // (the two cases below). These four can coexist, and each must have the client
    // to itself -- ssh2-sftp-client shares connection-level listeners, so two
    // handshakes, or a handshake and a close, at once is unsafe.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    // A handshake that takes a real macrotask, so an overlap would be recorded
    // rather than merely possible.
    connect.mockImplementation(async () => {
      await new Promise((settle) => setTimeout(settle, 5));
      state.live = true;
      const dialed = rawClient._sock as { writableEnded?: boolean } | undefined;
      if (dialed?.writableEnded !== undefined) dialed.writableEnded = false;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);
    const log = recordTransitions(adapter);

    // Fired in one synchronous run, with no await between them: the first dial,
    // an idle release, a cycle-start reconnect, and a recovery re-dial. The
    // public connect takes its queue slot synchronously, so the three behind it
    // queue rather than racing it.
    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const release = adapter.releaseForIdle();
    const ready = adapter.ensureConnected();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redial = (adapter as any).redialForRecovery() as Promise<void>;
    await Promise.all([dial, release, ready, redial]);

    expect(log).toEqual([
      "start:connect",
      "end:connect",
      "start:releaseForIdle",
      "end:releaseForIdle",
      "start:ensureConnected",
      "end:ensureConnected",
      "start:redialForRecovery",
      "end:redialForRecovery",
    ]);
    // The release closed what the first dial established and the cycle-start
    // reconnect dialed a fresh session; the recovery re-dial found that session
    // live and dialed nothing.
    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state.live).toBe(true);
  });

  test("a transition attempted after teardown is latched does not run", async () => {
    const { client, connect, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    await adapter.end();
    const log = recordTransitions(adapter);

    // Every kind that can be requested after the latch, each returning what its
    // caller treats as "nothing to do" -- except a re-open, which is refused.
    await expect(adapter.ensureConnected()).resolves.toBe(true);
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).redialForRecovery() as Promise<string>,
    ).resolves.toBe("noSession");
    await expect(adapter.connect({ host: "h" })).rejects.toThrow(
      "cannot be reopened",
    );

    // None of them ran a body at all: no dial, and no second close.
    expect(log).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("a transition already in flight when teardown is latched is awaited by teardown before it returns", async () => {
    // The release is between the ssh2 Client's end() and its 'close' when close()
    // reaches end(). Teardown holds no privileged entry: it takes the queue behind
    // the release and runs ssh2-sftp-client's end() only once that release is done.
    const { client, rawClient } = slowClosingClient(wrapperMethods());
    const events: string[] = [];
    rawClient.on("close", () => events.push("release:closed"));
    const drivenEnd = rawClient.end as () => void;
    rawClient.end = vi.fn(() => {
      events.push("release:ssh2-end");
      drivenEnd();
    });
    client.end = vi.fn(async () => {
      events.push("teardown:client.end");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const release = adapter.releaseForIdle();
    const closed = adapter.end();
    await Promise.all([release, closed]);

    expect(events).toEqual([
      "release:ssh2-end",
      "release:closed",
      "teardown:client.end",
    ]);
  });

  test("the first dial acquires, so teardown cannot run the client down under it", async () => {
    // core's open() dials and its close() tears down; nothing above the adapter
    // orders them. A teardown that ran ssh2-sftp-client's end() under a live
    // handshake would short-circuit on the session that handshake has not
    // established yet, resolving WITHOUT ending the ssh2 Client -- so close()
    // would return while an SSH dial still holds a ref'd socket.
    const wrapper = wrapperMethods();
    const state = { live: false };
    const events: string[] = [];
    let dialsInFlight = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        await new Promise((settle) => setTimeout(settle, 20));
        state.live = true;
      } finally {
        dialsInFlight -= 1;
        events.push("dial:end");
      }
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn(async () => {
        events.push(`teardown:client.end (dialsInFlight=${dialsInFlight})`);
        return true;
      }),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const closed = adapter.end();
    await Promise.all([dial, closed]);

    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
  });

  test("a transition that rejects releases the serialization rather than pinning every later one", async () => {
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Two transitions queued behind a release that raises out of its body. The
    // rejection handler is attached in the same synchronous run, so the failure is
    // never momentarily unhandled.
    const failing = adapter.releaseForIdle();
    const rejected = expect(failing).rejects.toThrow(
      "socket already destroyed",
    );
    const queued = Promise.allSettled([
      adapter.ensureConnected(),
      adapter.releaseForIdle(),
    ]);
    await rejected;

    // Both reached the front and ran: the reconnect found the session the failed
    // release never closed, and the second release raised out of the same end().
    const outcome = await Promise.race([
      queued.then((results) => results.map((result) => result.status).join()),
      new Promise((resolve) => setTimeout(() => resolve("pinned"), 250)),
    ]);
    expect(outcome).toBe("fulfilled,rejected");
    // And the queue is still usable for the transition after them.
    await expect(adapter.end()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledOnce();
  });

  test("a dial or a close driven outside the transition that owns it fails loudly", async () => {
    // The chokepoint: ssh2-sftp-client's connect() and end(), the ssh2 Client's
    // own end(), and the forced socket destroys all reach the transport through
    // one of these three, so each refusing to run unlocked is what makes "every
    // dial and every close is serialized" a check rather than a reading of the
    // call graph. Each is handed a FOREIGN transition token, which is the form the
    // check has to catch: an abandoning teardown drives its forced close while
    // another transition is running, so a chokepoint that asked only whether SOME
    // transition was in progress would pass every one of these the moment one was.
    const { client, connect } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;
    const foreign = { kind: "connect", recordBoundary: () => {} };

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    await expect(
      internals.connectLocked({ host: "h" }, foreign) as Promise<void>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    await expect(
      internals.closeTerminally(foreign) as Promise<void>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    await expect(
      internals.awaitBoundedTeardown(
        foreign,
        Promise.resolve(),
        10,
        undefined,
        false,
      ) as Promise<unknown>,
    ).rejects.toThrow("outside the SFTP session transition that owns it");
    // Each refused BEFORE it drove anything: no second dial, and no close on a
    // connection the adapter is not tearing down.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();

    // And the same three, driven from inside a transition that IS running but is
    // not theirs: the release below holds the queue while each is driven with the
    // token of a transition that has already left.
    const held: unknown[] = [];
    const release = internals.runTransition({
      kind: "releaseForIdle",
      skipped: () => undefined,
      abandoned: () => undefined,
      run: async (mine: unknown) => {
        held.push(
          await internals
            .connectLocked({ host: "h" }, foreign)
            .then(() => "dialed")
            .catch((error: Error) => error.message),
        );
        // The token of the transition actually running is accepted, which is what
        // makes the three failures above a check on identity rather than on the
        // shape of the argument.
        expect(() =>
          internals.assertTransitionHeld("a probe", mine),
        ).not.toThrow();
      },
    }) as Promise<void>;
    await release;
    expect(held).toEqual([
      expect.stringContaining(
        "outside the SFTP session transition that owns it",
      ),
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("the abandoned teardown's forced close is exempt only while teardown is latched", async () => {
    // The one mechanism that runs while ANOTHER transition holds the client, so it
    // cannot present the holder's token -- and it must not be free of a check
    // either. What makes it safe is the teardown latch: end() latches before it
    // enqueues, so every transition behind the abandoning teardown skips its body
    // and the holder ahead of it is the only one that can be running. Driven here
    // with no latch, which is the state that must fail.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = adapter as any;

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const socket = rawClient._sock as { destroy: ReturnType<typeof vi.fn> };

    expect(() => internals.forceCloseAbandonedTeardown()).toThrow(
      "with no teardown latched",
    );
    expect(socket.destroy).not.toHaveBeenCalled();

    internals.session.beginClose();
    internals.forceCloseAbandonedTeardown();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  test("an abandoned teardown that cannot close the transport still stops the keepalive", async () => {
    // The degraded branch reports this teardown DONE over a transport it could not
    // close, so the keepalive must not go on beating against that connection --
    // which is why the stop precedes the call site, exactly as it does in the terminal
    // close. Driven in the default held-session mode, the one that arms a heartbeat.
    vi.useFakeTimers();
    try {
      const { client, rawClient } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      captureAdapterLog(adapter);
      installClient(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      // An ssh2 that relocated the socket's destroy, the one call site this path drives.
      delete (rawClient._sock as { destroy?: unknown }).destroy;
      internals.session.beginClose();
      internals.forceCloseAbandonedTeardown();

      expect(adapterLog(adapter).warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "not compatible with the installed SFTP library",
        ),
      );
      expect(adapterLog(adapter).debug).toHaveBeenCalledWith(
        expect.stringContaining("client._sock.destroy()"),
      );
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS * 3);
      expect(client.realPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an operation on a live session takes no session transition at all", async () => {
    // The gate's fast path: with no release outstanding and none standing
    // unreconciled, an operation is issued with no acquire and not even a
    // microtask of delay, so the steady state inside a cycle costs exactly what
    // it did before the mode existed.
    const { client } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const log = recordTransitions(adapter);

    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(log).toEqual([]);
  });

  test("a release whose ssh2 call sites went away after the dial fails loudly", async () => {
    // The release resolves the call sites again where it drives them, not only at the
    // dial: an ssh2 that relocated one between the two would otherwise reach a
    // TypeError at the idle boundary instead of the actionable error the dial-time
    // check gives.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    delete rawClient.end;

    const release = adapter.releaseForIdle();
    await expect(release).rejects.toThrow(
      "which the installed SFTP library does not support",
    );
    expect(adapterLog(adapter).debug).toHaveBeenCalledWith(
      expect.stringContaining("client.end()"),
    );
  });

  test("a transition that needs the retained connect options and has none fails loudly", async () => {
    // Neither re-dial is reachable before the first connect -- the recovery
    // classifier refuses with no retained options, and core dials before it polls
    // -- so each states that as a check rather than dialing with undefined.
    const { client, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);
    // No session either, so each reaches its dial rather than returning on a live
    // one.
    state.live = false;

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).redialForRecovery() as Promise<void>,
    ).rejects.toThrow("a server-driven operation ran before connect()");
    await expect(adapter.ensureConnected()).rejects.toThrow(
      "a poll cycle ran before connect()",
    );
  });

  // --- the bounded acquire, and what an expired wait means -------------------
  //
  // The wait for the transition ahead is bounded; the transition being waited on
  // is not. A waiter whose bound expires abandons its OWN transition and proceeds
  // into no session action of its own -- teardown's forced socket destroy being
  // the single, narrow exception.

  // The bound the adapter arms on every queued acquire. Duplicated from the
  // adapter (the constant is not exported by design: it is a liveness safety
  // check, not a call site), so the cases below can sit either side of it.
  const ACQUIRE_BOUND_MS = 10_000;

  // The two bounds a release spends in its worst case, duplicated from the adapter
  // for the same reason, so the case that drives their sum against the bound above
  // can sit either side of each.
  const CLIENT_CLOSE_BOUND_MS = 5_000;
  const FORCED_CLOSE_BOUND_MS = 1_000;

  // A dial that never settles on its own but DOES settle when something destroys the
  // transport beneath it, because that is what the real stack does: a destroy
  // mid-handshake cuts the parked attempt short and it rejects with an
  // unexpected-close error indistinguishable from a peer's (measured; see
  // docs/spec/DEPENDENCY_PINS.md). A dial that stayed parked through the destroy
  // would hide what this adapter reports about that rejection, which is the
  // operator-facing half of what an abandoning teardown does.
  function parkDialUntilTransportDestroyed(
    connect: ReturnType<typeof vi.fn>,
    rawClient: EventEmitter,
  ): void {
    connect.mockImplementation(
      () =>
        new Promise<void>((_settle, reject) => {
          rawClient.once("close", () => {
            reject(
              Object.assign(
                new Error("getConnection: Unexpected close event"),
                {
                  code: "ERR_GENERIC_CLIENT",
                },
              ),
            );
          });
        }),
    );
  }

  // A cycle-start dial parked that way, entered on an idle queue so it HOLDS the
  // transition while everything requested behind it waits. Its own ceiling is its
  // caller's, which is exactly what the lock does not bound.
  function neverSettlingHolder(
    adapter: SSH2SFTPClientAdapter,
    connect: ReturnType<typeof vi.fn>,
    state: { live: boolean },
    rawClient: EventEmitter,
  ): Promise<boolean> {
    state.live = false;
    parkDialUntilTransportDestroyed(connect, rawClient);
    const holder = adapter.ensureConnected();
    void holder.catch(() => {});
    return holder;
  }

  test("the acquire is bounded: a queued transition gives up rather than waiting out the one ahead of it", async () => {
    // The counterpart of the property this lock shipped with. What is unbounded is
    // the transition being waited on -- the never-settling dial below is still
    // parked ten minutes later, because its ceiling is its caller's -- while the
    // WAIT for it is the adapter's own and ends at the bound.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      let holderSettled = false;
      const holder = neverSettlingHolder(adapter, connect, state, rawClient);
      void holder.then(
        () => {
          holderSettled = true;
        },
        () => {
          holderSettled = true;
        },
      );
      const released = adapter.releaseForIdle();
      const ready = adapter.ensureConnected();

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      await expect(released).resolves.toBeUndefined();
      await expect(ready).resolves.toBe(false);
      expect(holderSettled).toBe(false);
      // Neither drove its own close or dial: the dial ahead of them still holds
      // the client.
      expect(rawClient.end).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("each transition kind enqueued behind a never-settling sibling abandons at the bound", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const settled: Record<string, string> = {};
      const record = (name: string, promise: Promise<unknown>): Promise<void> =>
        promise.then(
          (value) => {
            settled[name] = `resolved ${String(value)}`;
          },
          (error: unknown) => {
            settled[name] = `rejected ${String((error as Error).message)}`;
          },
        );
      // All five kinds, requested before end() latches so each takes a real queue
      // slot. Teardown is last for that reason.
      const waiters = [
        record("connect", adapter.connect({ host: "h" })),
        record("ensureConnected", adapter.ensureConnected()),
        record(
          "redialForRecovery",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (adapter as any).redialForRecovery() as Promise<string>,
        ),
        record("releaseForIdle", adapter.releaseForIdle()),
        record("teardown", adapter.end()),
      ];

      // Just inside the bound, every one of them is still waiting.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS - 1_000);
      expect(settled).toEqual({});
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.all(waiters);

      // Each on the terms its kind states: the cycle-start dial reports a cycle to
      // skip, the release that it released nothing, the recovery re-dial that no
      // session is live for the re-issue, teardown that the close is done (it
      // closed the transport from this side), and the first dial -- which has no
      // value that could mean "no session was established" -- rejects.
      expect(settled).toEqual({
        connect: expect.stringContaining(
          `waited ${ACQUIRE_BOUND_MS} ms for the session transition ahead of it`,
        ),
        ensureConnected: "resolved false",
        redialForRecovery: "resolved noSession",
        releaseForIdle: "resolved undefined",
        teardown: "resolved undefined",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a recovery re-dial that abandons over a held dead session fails the operation rather than re-issuing it", async () => {
    // The other arm of the abandoned re-dial's reading. Giving up the wait clears
    // nothing, so a session the partner dropped while withholding its close is
    // still held over a transport that can send nothing: a re-issue there would
    // ride the per-operation deadline a second time to reach the loss the
    // operation already has.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);
      // The partner dropped this cycle's session and withheld its close while the
      // dial above still holds the transition.
      state.live = true;
      socket.writableEnded = true;
      client.delete.mockRejectedValueOnce(
        new TransportOperationStalledError(
          "SFTP file delete of /remote/x.json stalled: no response from the " +
            "server; refusing to wait on the server further",
        ),
      );

      const failing = adapter.delete("/remote/x.json").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      expect(await failing).toBeInstanceOf(TransportOperationStalledError);
      expect(client.delete).toHaveBeenCalledOnce();
      // The abandon drove nothing on the client the dial ahead of it holds, and
      // established nothing to count or report as a survived drop.
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("both cycle-boundary signals pace their declined-wait warning, on their own counts", async () => {
    // Core drives ensureConnected and releaseForIdle once each per poll cycle, and
    // one stuck transition declines both of them every cycle for as long as it
    // holds, so each line follows the cadence a chronic condition already gets
    // here: the first, then every SFTP_REDIAL_WARN_INTERVAL-th. The two are paced
    // on separate counts -- a shared one would escalate each line on the other
    // path's occurrences and misstate both numbers.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const cycles = SFTP_REDIAL_WARN_INTERVAL + 2;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const ready = adapter.ensureConnected();
        const released = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
        await expect(ready).resolves.toBe(false);
        await expect(released).resolves.toBeUndefined();
      }
      // One release declined with no cycle-start dial beside it, so the two counts
      // are no longer the same number and the end-of-run total below can only be
      // the release's own.
      const lastRelease = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
      await expect(lastRelease).resolves.toBeUndefined();

      const warned = adapterLog(adapter).warn.mock.calls.flat() as string[];
      const declinedRedials = warned.filter((line) =>
        line.includes("ephemeral SFTP re-dial declined:"),
      );
      const declinedReleases = warned.filter((line) =>
        line.includes(
          "The connection-per-poll idle release did not close the SFTP session:",
        ),
      );
      expect(declinedRedials).toHaveLength(2);
      expect(declinedReleases).toHaveLength(2);
      expect(warned).toHaveLength(4);
      // The number in each escalated line is that path's own total, which is what
      // tells the operator how many cycles the condition has now cost.
      expect(declinedRedials[1]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} cycles skipped this way`,
      );
      expect(declinedReleases[1]).toContain(
        `${SFTP_REDIAL_WARN_INTERVAL} idle boundaries released nothing this way`,
      );
      // What the end-of-run summary reports is every occurrence, not the paced
      // subset the log holds -- and the two signals total separately there too,
      // the release having declined once more than the cycle-start dial did. A
      // decline closed nothing, so it is neither a forced release nor a boundary
      // the partner closed on request, and none of the totals share a tally.
      expect(adapter.declinedReleaseCount).toBe(cycles + 1);
      expect(adapter.declinedCycleRedialCount).toBe(cycles);
      expect(adapter.forcedReleaseCount).toBe(0);
      expect(adapter.releasedBoundaryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abandoning waiter drives no connect, no client end(), and no destroy", async () => {
    // Asserted through the chokepoint rather than by counting calls alone: every
    // dial and every close presents the transition it runs inside, and the only
    // one that reaches the transport here is the holder's own dial. A chokepoint
    // that asked merely whether SOME transition was in progress would pass an
    // abandoning waiter's dial or close, since the sibling it gave up on is still
    // holding -- which is why the reading is identity. Teardown is excluded: it is
    // the one kind whose abandon does drive something, and it has its own case.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const chokepoint: string[] = [];
      const assertHeld = internals.assertTransitionHeld.bind(adapter);
      internals.assertTransitionHeld = (mechanism: string, held: unknown) => {
        chokepoint.push(
          `${mechanism} owner=${String(held === internals.transitionInProgress)}`,
        );
        assertHeld(mechanism, held);
      };

      neverSettlingHolder(adapter, connect, state, rawClient);
      const waiters = Promise.all([
        adapter.connect({ host: "h" }).catch(() => "rejected"),
        adapter.ensureConnected(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (adapter as any).redialForRecovery() as Promise<boolean>,
        adapter.releaseForIdle(),
      ]);
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);
      await waiters;

      // One dial reached the transport, the holder's, and it presented the
      // transition that was running.
      expect(chokepoint).toEqual(["ssh2-sftp-client's connect() owner=true"]);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(client.end).not.toHaveBeenCalled();
      expect(rawClient.end).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abandoned transition frees the queue rather than pinning every later one", async () => {
    // Two halves, and the second is the trap: an abandoning waiter must give up its
    // own turn WITHOUT resolving its queue slot, because its successor waits on IT
    // rather than on the transition actually holding the client. A slot resolved on
    // the way out would admit that successor into its critical section alongside a
    // holder that has not settled -- two overlapping transitions on the one shared
    // client, which is the corruption the lock exists to prevent.
    vi.useFakeTimers();
    try {
      const { client, connect, state, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      // A dial that settles well past both waiters' bounds.
      state.live = false;
      connect.mockImplementation(async () => {
        await new Promise((settle) => setTimeout(settle, 25_000));
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });
      const holder = adapter.ensureConnected();
      const released = adapter.releaseForIdle();

      // The successor acquires late, so its own bound has not expired when the
      // release's does: if the release freed its slot on the way out, this would
      // enter its critical section here, with the dial still holding.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS - 2_000);
      const successor = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(released).resolves.toBeUndefined();
      expect(log).toEqual(["start:ensureConnected"]);

      // The successor abandons in its own turn rather than running behind the
      // release, and the dial ahead of both is still the only body that has run.
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS);
      await expect(successor).resolves.toBe(false);
      expect(log).toEqual(["start:ensureConnected"]);

      // Then the dial settles and the queue is usable again: nothing was pinned by
      // the two abandons.
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(holder).resolves.toBe(true);
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      expect(log).toEqual([
        "start:ensureConnected",
        "end:ensureConnected",
        "start:releaseForIdle",
        "end:releaseForIdle",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown that abandons still reaches its forced destroy", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const holder = neverSettlingHolder(adapter, connect, state, rawClient);

      const closed = adapter.end();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      await expect(closed).resolves.toBeUndefined();
      // The destroy, and ONLY the destroy: ssh2-sftp-client's end() would
      // short-circuit on the session the live handshake has not restored and
      // resolve having closed nothing, and the ssh2 Client's own end() is the
      // release's mechanism, not teardown's.
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
      expect(client.end).not.toHaveBeenCalled();
      expect(rawClient.end).not.toHaveBeenCalled();
      // The dial the destroy cut short reports the cycle it could not complete, and
      // reports it SILENTLY: its rejection is the one a peer close produces, so
      // warning about a transient dial failure -- and promising a retry on a next
      // tick this closing run does not have -- would tell the operator the partner
      // dropped a connection this adapter closed itself.
      await expect(holder).resolves.toBe(false);
      // Reported to the operator at default verbosity, naming the cause: a slow
      // transition of this adapter's own rather than a slow partner. Neither a
      // warning nor an error, so a run that already succeeded is still treated as one.
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
      expect(adapterLog(adapter).error).not.toHaveBeenCalled();
      expect(adapterLog(adapter).info.mock.calls.flat()).toEqual([
        expect.stringContaining(
          `did not complete within the ${ACQUIRE_BOUND_MS} ms teardown wait`,
        ),
      ]);
      // And nothing counted the deliberate close as a mid-exchange drop.
      expect(adapter.reconnectCount).toBe(0);
      expect(adapter.midExchangeReconnectCount).toBe(0);
      expect(adapter.forcedReleaseCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an operation whose recovery re-dial the teardown cut short reports the loss it was recovering from", async () => {
    // The other half of the same misattribution. A recovery re-dial can be the dial
    // an abandoning teardown destroys the transport beneath, and that rejection is
    // the one a peer close produces -- so the operation would report this adapter's
    // own close in place of the session loss it was recovering from. Told apart by
    // the adapter's own reading of what it did, never by matching the error. Driven
    // in the default held-session mode, the one mid-exchange recovery was built for.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      // The session drops mid-operation, and the re-dial that follows parks on a
      // handshake that never settles.
      state.live = false;
      parkDialUntilTransportDestroyed(connect, rawClient);
      const listed = adapter.exists("/remote/out.json").then(
        () => "listed",
        (error: unknown) => (error as Error).message,
      );
      // The operation's own rejection and the recovery round after it are several
      // microtasks deep, so the re-dial is awaited into place: the teardown has to
      // queue BEHIND it rather than enter an idle queue ahead of it.
      await vi.advanceTimersByTimeAsync(10);
      expect(connect).toHaveBeenCalledTimes(2);
      // Now the re-dial holds the transition, so the teardown behind it gives up its
      // wait and destroys the transport beneath that dial.
      const closed = adapter.end();
      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1_000);

      await expect(closed).resolves.toBeUndefined();
      expect(socket.destroy).toHaveBeenCalledOnce();
      // The loss it was recovering from, not the unexpected-close error the destroy
      // produced on the dial.
      await expect(listed).resolves.toBe(
        "exists: No SFTP connection available",
      );
      expect(adapterLog(adapter).warn).not.toHaveBeenCalled();
      // The partner took this session before any teardown began, so it is counted
      // as the lost session it was; what the teardown cut short is the RECOVERY,
      // and no line reports one, because none completed.
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown queued behind a release that spends its whole close budget waits it out", async () => {
    // The relationship the acquire bound's value rests on, driven rather than
    // derived: a release's worst case is CLIENT_CLOSE_TIMEOUT_MS and then
    // FORCED_CLOSE_TIMEOUT_MS, and a teardown queued behind one of those must wait
    // it out rather than destroy the transport from under it. Three independent
    // constants with no arithmetic in the source tying them together, so nothing but
    // a driven case can hold the relationship.
    vi.useFakeTimers();
    try {
      const { client, rawClient, socket } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      // A partner that answers neither the ssh2 Client's end() nor the destroy
      // beneath it, which is what makes the release spend both bounds in full: its
      // end() leaves the transport ended with the session still set, and the forced
      // close's own wait for the 'close' that would clear it expires too.
      rawClient.end = vi.fn(() => {
        socket.writableEnded = true;
      });
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
      });

      const settled: string[] = [];
      const released = adapter.releaseForIdle().then(
        () => settled.push("released"),
        () => settled.push("release raised"),
      );
      const closed = adapter.end().then(() => settled.push("closed"));

      // Past the release's first bound and into its second, the teardown behind it
      // is still waiting rather than giving up.
      await vi.advanceTimersByTimeAsync(
        CLIENT_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS - 1,
      );
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toEqual(["release raised", "closed"]);
      await Promise.all([released, closed]);
      // The teardown ran its BODY: it drove ssh2-sftp-client's end(), which the
      // abandon path never does, and the only destroy is the release's own -- a
      // second one would be the abandon's.
      expect(log).toEqual([
        "start:releaseForIdle",
        "end:releaseForIdle",
        "start:teardown",
        "end:teardown",
      ]);
      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(adapterLog(adapter).info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a caller that gives up waiting for end() still gets the forced destroy", async () => {
    // What this bound owes the budget end()'s CALLER holds: nothing. Core races
    // end() against one of its own that a low peer_timeout_ms can put under this
    // bound, and abandoning that wait closes nothing -- the destroy is what closes
    // the transport, and the abandon drives it whether or not anything is still
    // waiting on it, which is what leaves that caller an exited process rather
    // than a half-open socket.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);

      const callerBudgetMs = 3_000;
      const closed = adapter.end();
      const callerWait = Promise.race([
        closed.then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("gave up"), callerBudgetMs);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(callerBudgetMs);
      await expect(callerWait).resolves.toBe("gave up");
      expect(socket.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        ACQUIRE_BOUND_MS - callerBudgetMs + 1_000,
      );
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a sibling that settles just inside the bound leaves the waiter running its transition normally", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const log = recordTransitions(adapter);

      state.live = false;
      connect.mockImplementation(async () => {
        await new Promise((settle) =>
          setTimeout(settle, ACQUIRE_BOUND_MS - 500),
        );
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });
      const holder = adapter.ensureConnected();
      const released = adapter.releaseForIdle();

      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS);

      await expect(holder).resolves.toBe(true);
      await expect(released).resolves.toBeUndefined();
      // The release ran its body and closed the session the dial established: no
      // premature abandon, and nothing warned.
      expect(log).toEqual([
        "start:ensureConnected",
        "end:ensureConnected",
        "start:releaseForIdle",
        "end:releaseForIdle",
      ]);
      expect(rawClient.end).toHaveBeenCalledOnce();
      // Nothing was abandoned, so neither the declined-release nor the declined
      // cycle-redial line fired. The dial's own line is the drop this setup
      // stages -- the session was cleared before it ran, which that dial absorbed
      // and reports -- and is not what this case is about.
      expect(
        adapterLog(adapter).warn.mock.calls.filter(([message]: [string]) =>
          String(message).includes("did not complete within"),
        ),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the acquire bound's timer is ref'd", async () => {
    // A liveness bound the process can exit out from under is not a bound, and the
    // abandon this one arms is what closes a transport nothing else will. Nothing
    // measures a process-exit difference behind the ref -- the transition being
    // waited on is itself parked on a ref'd socket handle -- so it is the safe
    // default rather than a driven consequence, and dropping it would otherwise be
    // a silent change.
    vi.useFakeTimers();
    const armed: { delayMs: number; handle: { hasRef(): boolean } }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delayMs?: number,
        ...rest: unknown[]
      ) => {
        const handle = realSetTimeout(callback, delayMs, ...rest);
        armed.push({
          delayMs: delayMs ?? 0,
          handle: handle as unknown as { hasRef(): boolean },
        });
        return handle;
      }) as unknown as typeof setTimeout);
    try {
      const { client, connect, state, rawClient } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      neverSettlingHolder(adapter, connect, state, rawClient);
      const released = adapter.releaseForIdle();

      // Identified by its unexported liveness safety-check delay, read before the
      // wait settles and clears it.
      const acquireBound = armed.filter(
        (timer) => timer.delayMs === ACQUIRE_BOUND_MS,
      );
      expect(acquireBound).toHaveLength(1);
      expect(acquireBound[0].handle.hasRef()).toBe(true);

      await vi.advanceTimersByTimeAsync(ACQUIRE_BOUND_MS + 1);
      await expect(released).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a wait that is won leaves no timer behind it", async () => {
    // The bound's timer is ref'd, so one still pending after its wait was won
    // would hold an otherwise drained process for the remainder of the bound --
    // on the ORDINARY path, at every queued acquire, with nothing having gone
    // wrong. What a leak looks like is growth, one timer per acquire, so the
    // steady state across cycles is the reading rather than any fixed count; the
    // cycles stay well inside the bound, past which a leaked timer would have
    // fired and read the same as one that was cleared.
    vi.useFakeTimers();
    try {
      const { client, connect, state, rawClient, socket } =
        ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const dialMs = 1_000;
      connect.mockImplementation(async () => {
        await new Promise((settle) => setTimeout(settle, dialMs));
        state.live = true;
        socket.writableEnded = false;
        socket.destroyed = false;
      });

      const timersAfterCycle: number[] = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        state.live = false;
        const dialed = adapter.ensureConnected();
        // Queued behind that dial, so its acquire arms the bound and then wins it
        // well inside it.
        const released = adapter.releaseForIdle();
        await vi.advanceTimersByTimeAsync(dialMs + 1);
        await expect(dialed).resolves.toBe(true);
        await expect(released).resolves.toBeUndefined();
        timersAfterCycle.push(vi.getTimerCount());
      }

      // Each release ran its BODY rather than abandoning, which is what makes
      // these waits won ones.
      expect(rawClient.end).toHaveBeenCalledTimes(3);
      expect(timersAfterCycle).toEqual([
        timersAfterCycle[0],
        timersAfterCycle[0],
        timersAfterCycle[0],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a dial behind a latched teardown stops retrying between attempts", async () => {
    // The other half of the fix, and not a substitute for the bound: with the wait
    // bounded, an abandoning teardown destroys the socket beneath a mid-handshake
    // dial and that attempt rejects as an unexpected close -- but the retry loop
    // would then mint a FRESH socket and keep a torn-down connection, and a process
    // that exits by drain, alive for the remainder of the dial budget (measured
    // against the real stack). So the loop reads the teardown latch between
    // attempts, exactly as runTransition reads it before a transition's body.
    vi.useFakeTimers();
    try {
      const { client, connect, state } = ephemeralClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      captureAdapterLog(adapter);
      installClient(adapter, client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

      // The control: the same rejection with no teardown latched spends the whole
      // retry budget, so the case below is the latch and not the rejection.
      state.live = false;
      let attempts = 0;
      connect.mockImplementation(async () => {
        attempts += 1;
        throw new Error("getConnection: Unexpected close event");
      });
      const control = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(control).resolves.toBe(false);
      expect(attempts).toBe(3);

      attempts = 0;
      connect.mockImplementation(async () => {
        attempts += 1;
        // What an abandoning teardown leaves behind: the latch set, and the socket
        // beneath this very attempt destroyed under it.
        internals.session.beginClose();
        throw new Error("getConnection: Unexpected close event");
      });
      const latched = adapter.ensureConnected();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(latched).resolves.toBe(false);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
