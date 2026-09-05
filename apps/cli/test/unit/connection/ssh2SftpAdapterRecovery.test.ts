// What the adapter does when its one held session drops mid-exchange.

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi } from "vitest";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { SFTP_REDIAL_WARN_INTERVAL } from "../../../src/connection/sftpAdapterLedger";
import { SFTP_HEARTBEAT_INTERVAL_MS } from "../../../src/connection/sftpHeartbeat";
import {
  captureAdapterLog,
  installClient,
  notConnected,
  pendingExists,
  releasableClient,
} from "./ssh2SftpAdapterFixtures";

// --- session recovery (mid-exchange re-dial) ---------------------------------
//
// On a CLEAN session loss (the ssh2-sftp-client `sftp` property cleared, no fatal
// protocol error, no liveness stall) the adapter transparently re-dials through
// connect() -- reusing the retained full connect options (pinned host key, stored
// credentials, reconnect bound) -- and re-issues the operation ONCE. A fatal
// error, a stall, a memory bound, or a host-key mismatch on the re-dial stays
// terminal. These pin the trigger, the bound, the per-op idempotency resolvers,
// and the teardown suppression, all driven by a mock whose `sftp` property toggles
// to model a server dropping the one long-lived session mid-exchange.

describe("session recovery", () => {
  // A raw SFTPWrapper stand-in carrying the four methods connect()'s presence
  // guard checks plus the EventEmitter `on` the fatal-'error' guard attaches to.
  function sessionWrapper(overrides: Record<string, unknown> = {}) {
    return {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
      on: vi.fn(),
      ...overrides,
    };
  }

  // A mock ssh2-sftp-client whose `sftp` property is live until `state.live` is
  // flipped false (a mid-exchange drop) and restored to `wrapper` by connect() (a
  // re-dial). High-level ops are attached per test and read `state.live` to model
  // ssh2-sftp-client's ERR_NOT_CONNECTED rejection on a cleared session.
  //
  // The raw ssh2 Client under it is an EventEmitter, as the pinned ssh2's is: the
  // recovery re-dial watches its 'end'/'close' pair to tell a transport that still
  // owes its 'close' from one whose events have all been delivered, and a Client
  // that cannot be watched puts the re-dial on a different branch entirely. Here
  // no lifecycle event is emitted at all, which is the drop these tests model --
  // the raw-wrapper class, whose whole sequence has run by the time recovery is
  // entered.
  function droppable(wrapper: ReturnType<typeof sessionWrapper>) {
    const state = { live: true };
    const connect = vi.fn().mockImplementation(async () => {
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, connect, state };
  }

  test("recovers from a clean drop on list() and completes via one re-dial", async () => {
    const wrapper = sessionWrapper({
      // Serve a two-entry directory: one batch, then EOF on the next readdir.
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (() => {
        let served = false;
        return (
          _h: Buffer,
          cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
        ) => {
          if (served) return cb(Object.assign(new Error("EOF"), { code: 1 }));
          served = true;
          cb(null, [
            { filename: "a.json", attrs: { mtime: 1, size: 1 } },
            { filename: "b.json", attrs: { mtime: 1, size: 2 } },
          ]);
        };
      })(),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    expect(connect).toHaveBeenCalledTimes(1);

    // Mid-exchange clean drop: the next list() finds the session cleared.
    state.live = false;
    const result = await adapter.list("/remote/dir");

    expect(result.map((e) => e.name)).toEqual(["a.json", "b.json"]);
    // Exactly one recovery re-dial (initial connect + one).
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers on createExclusive() and resolves a re-issued own-EEXIST as success", async () => {
    // The pre-drop create landed, so the re-issue sees its OWN lock file: the
    // server returns FILE_ALREADY_EXISTS (11), createExclusiveOnce normalizes it to
    // code "EEXIST", and the reissue resolver treats that as success rather than a
    // spurious lock conflict.
    const wrapper = sessionWrapper({
      open: vi
        .fn()
        .mockImplementation(
          (
            _p: string,
            _f: number,
            _a: object,
            cb: (e: Error | null, h: Buffer) => void,
          ) =>
            cb(
              Object.assign(new Error("exists"), { code: 11 }),
              Buffer.alloc(0),
            ),
        ),
      close: vi.fn((_h: Buffer, cb: (e: Error | null) => void) => cb(null)),
    });
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.createExclusive("/remote/lock.json"),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached open(); the first attempt short-circuited on the
    // cleared session.
    expect(wrapper.open).toHaveBeenCalledOnce();
  });

  test("fails terminally with no re-dial when max_reconnect_attempts is 0", async () => {
    // The mid-exchange reconnection budget IS max_reconnect_attempts in the default
    // held-session mode: a value of 0 permits zero reconnections, so the very first
    // drop fails terminally and no re-dial is even attempted. Terminal (a
    // UsageError) so the caller maps it to a non-zero exit, never a silent resolve
    // or hang. The message describes THIS case rather than the exhausted-budget one:
    // an allowance of zero lost sessions is not an allowance this exchange spent,
    // so quoting one would misdescribe an exchange that never reconnected at all.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    state.live = false;

    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(
      "max_reconnect_attempts=0 permits no mid-exchange reconnection",
    );
    expect((err as Error).message).toContain("this first drop is terminal");
    expect((err as Error).message).not.toContain("0 lost sessions");
    // Both remedies are still named by their operator-reachable names.
    expect((err as Error).message).toContain("--connection-per-poll");
    // No re-dial: the budget permits none, so only the initial connect ran.
    expect(connect).toHaveBeenCalledTimes(1);
    // The session was still lost, and the budget bounds sessions lost rather than
    // re-dials made, so the drop the budget refused is counted like any other.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  // A client that dials once and refuses every dial after it, so a drop's recovery
  // is stranded. That is what leaves an arm at the cumulative budget's check with
  // the session still gone, which is the only state the check refuses in: an arm
  // arriving over a session a re-dial restored finds it live and re-issues on it
  // without reaching the check at all.
  function undialableAfterFirst() {
    const wrapper = sessionWrapper();
    const state = { live: true };
    let dials = 0;
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials > 1) throw new Error("connection refused");
      state.live = true;
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, connect, state };
  }

  test("refuses a sibling arm at the cap boundary, on the unit their shared drop spent", async () => {
    // The cap boundary reached by a FAN rather than a serial run. One drop tears
    // two operations; the arm that reaches the transition first charges the loss
    // and takes the last unit, and when its re-dial fails the sibling behind it
    // arrives with no session to re-issue on and reads the budget its own loss
    // just filled. The refusal is fail-closed: the sibling raises the terminal
    // error rather than being given a dial the budget cannot pay for, so the whole
    // fan buys exactly the one re-dial their single lost session paid for. The
    // reading and what it costs an operator are in docs/spec/CHANNEL_SECURITY.md,
    // "What the accounting counts"; the case below is its serial counterpart.
    vi.useFakeTimers();
    const { client, connect, state } = undialableAfterFirst();
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    try {
      // A budget of one puts the boundary at the first drop: charging it leaves
      // nothing for the sibling.
      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      state.live = false;

      // Both arms are torn by the one drop and enter recovery over it; the
      // transition queue admits them one at a time.
      const arms = Promise.all([
        adapter.list("/remote/a").catch((e: unknown) => e),
        adapter.list("/remote/b").catch((e: unknown) => e),
      ]);
      // Past the 1 s dialing-retry delay of BOTH arms, so an arm the budget let
      // dial would settle inside this window too and be read as an outcome rather
      // than as a test that ran out of time.
      await vi.advanceTimersByTimeAsync(5_000);
      const outcomes = await arms;

      const refused = outcomes.filter((o) => o instanceof UsageError);
      expect(refused).toHaveLength(1);
      expect((refused[0] as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      // The arm that charged fails with its dial, not with the budget: it spent
      // the unit and got the re-dial the unit bought.
      const charging = outcomes.filter((o) => !(o instanceof UsageError));
      expect(charging).toHaveLength(1);
      expect((charging[0] as Error).message).toContain("connection refused");
      // One session lost is one unit, however many arms it tore: the sibling's
      // refusal charges nothing of its own.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      // The initial dial plus the charging arm's two attempts. The refused
      // sibling adds none: no dial is issued past the budget.
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reaches that boundary serially on the same loss and with the same dials", async () => {
    // The serial counterpart of the fan above, and what says the sibling's
    // refusal costs the operator nothing: with the last unit charged and its
    // re-dial failed, the NEXT operation raises the same terminal error over that
    // same charged loss and dials nothing further. Both shapes therefore end the
    // exchange on the loss the budget's last unit paid for, having spent the same
    // dials; what the fan changes is only which operation hears it.
    vi.useFakeTimers();
    const { client, connect, state } = undialableAfterFirst();
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    try {
      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      state.live = false;

      const charging = adapter.list("/remote/a").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const chargingError = await charging;
      expect(chargingError).not.toBeInstanceOf(UsageError);
      expect((chargingError as Error).message).toContain("connection refused");
      expect(adapter.midExchangeReconnectCount).toBe(1);
      const dialsSpent = connect.mock.calls.length;
      expect(dialsSpent).toBe(3);

      const next = adapter.list("/remote/b").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const nextError = await next;
      expect(nextError).toBeInstanceOf(UsageError);
      expect((nextError as Error).message).toContain(
        "the mid-exchange reconnection budget is exhausted",
      );
      // The same lost session, charged once and no more, and no dial past the
      // budget: the operation that hears the refusal buys nothing either.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(connect).toHaveBeenCalledTimes(dialsSpent);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails immediately on a host-key mismatch during the recovery re-dial", async () => {
    // A host-key mismatch on the re-dial is terminal for free via connect()'s
    // existing "Host denied" retry predicate: it must not spend the reconnect
    // budget re-running the key exchange against the same untrusted host.
    const wrapper = sessionWrapper();
    const state = { live: true };
    let calls = 0;
    const connect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        state.live = true;
        return;
      }
      throw new Error("Host denied (verification failed)");
    });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end: vi.fn().mockResolvedValue(true),
    };
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    // A non-zero reconnect budget makes the single-attempt assertion meaningful: a
    // working predicate refuses to spend it on a host-key rejection.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    state.live = false;

    await expect(adapter.list("/remote/dir")).rejects.toThrow("Host denied");
    // Initial connect + exactly one terminal re-dial attempt (budget untouched).
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("resolves a re-issued delete whose source is already absent", async () => {
    // A pre-drop delete that landed returns SSH_FX_NO_SUCH_FILE (code 2) on the
    // re-issue; the resolver maps it to success so poll()'s consume-delete poller
    // is not stopped by a delete that in fact succeeded.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let deleteCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("delete");
      deleteCalls += 1;
      throw Object.assign(new Error("No such file"), { code: 2 });
    });
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached the server; the first attempt saw the cleared
    // session.
    expect(deleteCalls).toBe(1);
  });

  test("resolves a re-issued rename whose destination already exists", async () => {
    // A pre-drop rename that landed leaves the source gone (code 2) on the
    // re-issue; because every rename destination is self-prefixed, a present
    // destination is unambiguously our own landed attempt, so the resolver
    // confirms it via exists(dest) and resolves as success.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let renameCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      renameCalls += 1;
      throw Object.assign(new Error("No such file From: a To: b"), { code: 2 });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(true);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.rename("/remote/id-joining.json", "/remote/id-hello.json"),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(renameCalls).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).exists).toHaveBeenCalledWith(
      "/remote/id-hello.json",
    );
  });

  test("re-dials on the exact ERR_NOT_CONNECTED clean-loss identity", async () => {
    // Pin the trigger against ssh2-sftp-client's high-level clean-loss rejection:
    // the first delete rejects with the exact ERR_NOT_CONNECTED identity while the
    // session is cleared, and recovery re-dials and re-issues to success.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("delete");
      // The re-issue succeeds cleanly (the file was still present).
    });
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("does NOT re-dial on a liveness stall even with the session cleared", async () => {
    // A TransportOperationStalledError is terminal, never a reconnect trigger:
    // re-dialing on a stall would hand a withholding server a free liveness reset.
    // Even with the session property cleared, a stall must propagate without a
    // re-dial.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi
      .fn()
      .mockRejectedValue(new TransportOperationStalledError("withheld"));
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    // No re-dial: the stall is terminal.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not re-dial once teardown has begun", async () => {
    // end() latches `closing`, so an op racing a clean close fails terminally
    // rather than launching a re-dial whose readyTimeout would slow the close and
    // whose fresh session would outlive teardown. The refusal is at the
    // classifier, before the recovery path is entered at all: with no
    // reconnection budget left, an op admitted to that path would report the
    // budget-exhausted error instead of the session diagnostic, so the diagnostic
    // is what says recovery was refused rather than merely thwarted.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();
    state.live = false;

    await expect(adapter.list("/remote/dir")).rejects.toThrow(
      "SFTP session is not open",
    );
    // No re-dial during teardown.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does not re-dial before any connect (no retained options)", async () => {
    // A server-driven op reaching the recovery path before connect() ran has
    // nothing to re-dial with; the original diagnostic must be reported unchanged
    // rather than a re-dial or the retained-options invariant error.
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    const connect = vi.fn();
    installClient(adapter, { sftp: null, connect });

    await expect(adapter.list("/remote/dir")).rejects.toThrow(
      "SFTP session is not open",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  test("recovers from a clean drop on get() via one re-dial", async () => {
    // get() is wired to withSessionRecovery identically to list/createExclusive:
    // the first attempt finds the session cleared, the re-dial re-establishes it,
    // and the re-issued read returns the file (the capped sink is rebuilt per call).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).get = vi
      .fn()
      .mockImplementation((_p: string, sink: Writable) => {
        if (!state.live) return Promise.reject(notConnected("get"));
        sink.write(Buffer.from("hello"));
        return Promise.resolve(sink);
      });
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const buf = await adapter.get("/remote/f.bin", { maxBytes: 32 });
    expect(buf.toString()).toBe("hello");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers from a clean drop on exists() via one re-dial", async () => {
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("exists");
      return true;
    });
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    await expect(adapter.exists("/remote/lock.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("recovers a re-runnable put (Buffer) via one re-dial", async () => {
    // A Buffer source is re-runnable: the re-issue rebuilds it and re-streams the
    // identical payload. retries: 0 keeps put()'s inner retry loop from burning
    // attempts on the dropped session before the recovery re-dial takes over.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let putCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn().mockImplementation(() => {
      if (!state.live) return Promise.reject(notConnected("put"));
      putCalls += 1;
      return Promise.resolve("ok");
    });
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.put(Buffer.from("payload"), "/remote/out.tmp", { flags: "w" }),
    ).resolves.toBe("ok");
    expect(connect).toHaveBeenCalledTimes(2);
    // Only the re-issue reached the server; the first attempt saw the cleared
    // session.
    expect(putCalls).toBe(1);
  });

  test("does NOT recovery-wrap a one-shot stream put (terminal, no re-pipe)", async () => {
    // A provided ReadableStream is one-shot: a first attempt half-drains it, so a
    // recovery re-issue would re-pipe an already-consumed stream and silently
    // upload nothing. put() must bypass withSessionRecovery for it, so a clean drop
    // fails terminally with no re-dial rather than re-piping a drained stream.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi
      .fn()
      .mockImplementation(() => Promise.reject(notConnected("put")));
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    const stream = Readable.from([Buffer.from("one-shot")]);
    await expect(adapter.put(stream, "/remote/out.tmp")).rejects.toThrow(
      "No SFTP connection available",
    );
    // No re-dial: the one-shot stream path never enters recovery.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("does NOT recovery-wrap an append-mode put even from a re-runnable source", async () => {
    // flags:"a" is not re-issue-idempotent: a recovery re-issue would double-write
    // the payload. So an append put is never recovery-wrapped even from a Buffer,
    // and a clean drop fails it terminally with no re-dial. (Every caller passes
    // "w" today; this pins the gate against a future append caller.)
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi
      .fn()
      .mockImplementation(() => Promise.reject(notConnected("put")));
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 2 });
    state.live = false;

    await expect(
      adapter.put(Buffer.from("payload"), "/remote/out.log", { flags: "a" }),
    ).rejects.toThrow("No SFTP connection available");
    // No re-dial: append mode bypasses recovery, so a clean drop is terminal.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("counts a successful recovery re-dial in reconnectCount", async () => {
    // A one-shot successful recovery re-dial re-establishes the session, so it must
    // register in the operator's reconnect metric even though connect()'s own
    // counter (which bumps only on an internal retry past the first) stays at zero.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    state.live = false;

    await adapter.list("/remote/dir");
    // The recovery re-dial's connect() succeeded on its first attempt, so connect()
    // added zero; the recovery increment is what reports the survived drop. It
    // registers in BOTH the merged reconnect total and the mid-exchange sub-count,
    // which the end-of-run summary reports apart from connect-time retries.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns the operator on the first mid-exchange re-dial, naming cause and remedy", async () => {
    // A silent recovery would hide a partner whose server caps session lifetime,
    // exactly the case this feature exists for. The first re-dial must WARN, and
    // the line must name the drop, the likely (partner-side, unchangeable) cause,
    // and the remedy so the operator can act.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;
    await adapter.list("/remote/dir");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    // (a) states the drop was mid-exchange and transparently re-dialed, and
    //     reassures that the exchange continues
    expect(message).toContain("dropped mid-exchange");
    expect(message).toContain("transparently");
    expect(message).toContain("the exchange continues");
    // (b) names the likely cause: a partner-side session-duration/idle cap the
    //     operator cannot change
    expect(message).toContain("session-duration or idle limit");
    expect(message).toContain("cannot");
    // (c) names the real remedy under the held-session model by the flag the
    //     operator can actually type, and correctly states that a longer poll interval
    //     helps only for a query-frequency reaction
    expect(message).toContain("--polling-frequency");
    expect(message).toContain("--connection-per-poll");
    // (d) does NOT repeat the stale, inaccurate claim that raising the poll
    //     interval holds the session open less often (it does not: one session is
    //     held open for the whole exchange regardless of poll cadence)
    expect(message).not.toContain("held open less often");
    // (e) states what is left of the cumulative budget, so "the exchange
    //     continues" is not read as an open-ended survival guarantee: one of the
    //     two re-dials is spent, and exhausting the budget is terminal.
    expect(message).toContain(
      "1 further mid-exchange re-dial is allowed by max_reconnect_attempts=2",
    );
    expect(message).toContain("before the exchange fails");
  });

  test("escalates by rate, not one warn line per mid-exchange drop", async () => {
    // A chronic capper must stay visible without spamming a warn line every poll
    // cycle: after the first re-dial the adapter warns only every
    // SFTP_REDIAL_WARN_INTERVAL-th, so a full interval of drops yields two lines
    // (the first drop and the Nth), never one per drop.
    const wrapper = sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });
    const { client, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    // A budget comfortably above the escalation interval so the cap does not fire:
    // this test exercises the warn cadence, not the reconnection cap.
    await adapter.connect({ host: "h", maxReconnectAttempts: 100 });

    // Drop and recover once per poll for a full escalation interval; connect()
    // restores state.live on each re-dial.
    for (let i = 0; i < SFTP_REDIAL_WARN_INTERVAL; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }

    // Every drop was transparently recovered ...
    expect(adapter.reconnectCount).toBe(SFTP_REDIAL_WARN_INTERVAL);
    expect(adapter.midExchangeReconnectCount).toBe(SFTP_REDIAL_WARN_INTERVAL);
    // ... but the operator saw only two warn lines (the first drop and the Nth),
    // never one per drop.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.length).toBeLessThan(SFTP_REDIAL_WARN_INTERVAL);
    // Both messages reassure that the exchange survives the drop and stay accurate
    // about the current single-session model (no "held open less often" claim).
    const first = warn.mock.calls[0][0] as string;
    expect(first).toContain("the exchange continues");
    expect(first).not.toContain("held open less often");
    const escalation = warn.mock.calls[1][0] as string;
    expect(escalation).toContain(`${SFTP_REDIAL_WARN_INTERVAL} times`);
    expect(escalation).toContain("the exchange continues");
    // Each line reports the budget REMAINING at that point, so a rising count is
    // clear as an approach to the terminal failure, not just as a tally.
    expect(first).toContain("99 further mid-exchange re-dials are allowed");
    expect(escalation).toContain(
      `${100 - SFTP_REDIAL_WARN_INTERVAL} further mid-exchange re-dials are allowed`,
    );
    // The escalation hedges the cause exactly as the first-drop message does: the
    // adapter cannot tell a session-duration cap from an idle cap, so it names
    // both rather than asserting one, and never claims to know it is a duration cap.
    expect(escalation).toContain("session-duration or idle limit");
    expect(escalation).not.toContain("capping session lifetime");
    expect(escalation).toContain("--polling-frequency");
    expect(escalation).toContain("connection-per-poll");
    expect(escalation).not.toContain("held open less often");
  });

  test("closes a session dialed during teardown and reports the original loss", async () => {
    // Latch `closing` WHILE the recovery re-dial is in flight (the entry-guard
    // teardown test above covers `closing` latched BEFORE the op). The post-re-dial
    // check must then tear down the freshly-dialed session so it does not outlive
    // the close, and report the original clean-loss error rather than re-issuing.
    const wrapper = sessionWrapper();
    const state = { live: true };
    let connectCalls = 0;
    let signalRedialStarted!: () => void;
    const redialStarted = new Promise<void>((r) => {
      signalRedialStarted = r;
    });
    let releaseRedial!: () => void;
    const redialGate = new Promise<void>((r) => {
      releaseRedial = r;
    });
    const connect = vi.fn().mockImplementation(async () => {
      connectCalls += 1;
      if (connectCalls === 1) {
        state.live = true;
        return;
      }
      // The recovery re-dial: signal that connect() has begun, then park until the
      // test latches `closing`, then complete the handshake so the post-re-dial
      // check runs against a freshly-established session.
      signalRedialStarted();
      await redialGate;
      state.live = true;
    });
    const end = vi.fn().mockResolvedValue(true);
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: releasableClient(),
      end,
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const listing = adapter.list("/remote/dir").catch((e: unknown) => e);
    // The re-dial's connect() is now parked mid-handshake.
    await redialStarted;
    // Teardown begins mid-re-dial, then the handshake completes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).session.beginClose();
    releaseRedial();

    const err = await listing;
    // The original clean-loss error is reported, not a re-issued result.
    expect((err as Error).message).toContain("SFTP session is not open");
    // The freshly-dialed session was torn down (its client.end() ran) and the op
    // did not re-issue into the closing adapter.
    expect(end).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    // The partner took this session before the teardown latched, so it is counted
    // as the lost session it was: what the teardown aborted is the RECOVERY, and
    // the counters report sessions lost rather than recoveries completed.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("preserves the original rename error when the re-issue's exists() probe rejects", async () => {
    // rename()'s re-issue confirms a landed pre-drop rename via exists(dest); if
    // that probe itself rejects, the ambiguity is unresolved, so the outcome is
    // the undetermined one -- holding the ORIGINAL rename error, not the probe's
    // failure (mirrors createExclusiveOnce's SFTPv3 fallback to the original
    // openErr).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      // The re-issue sees the source gone (a landed pre-drop rename): code 2.
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi
      .fn()
      .mockRejectedValue(new Error("network timeout during exists()"));
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    // The original rename error (code 2) is the cause, not the exists() rejection,
    // and it is the original that reaches the operator: asserted where they read
    // it, since the wrapper's own message names only the destination.
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain("No such file");
    expect(rendered).not.toContain("network timeout");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // The re-issue's existence probe is a server round trip like the rename it
  // confirms, so it is issued through the private existsOnce: the call site
  // holding the outstanding-operation count, the per-operation deadline, and the
  // dead-session guard. The cases below pin what that call site buys on this path;
  // what the count itself buys is pinned in the connection-per-poll block, the
  // one mode where a boundary can fall while the probe is on the wire. Whichever
  // way the probe fails, it confirms nothing, so the rename fails with the
  // ORIGINAL error -- and fails promptly, rather than riding the whole-exchange
  // budget.

  test("refuses the re-issue's probe on a session already dead rather than hanging on it", async () => {
    // A fatal protocol error can land on the re-issued rename's own reply: the
    // wrapper is destroyed, so a stat posted onto it would buffer on a channel
    // that never answers and ride the whole-exchange budget. The probe's entry
    // guard rejects instead, and the rename fails with the error it already had.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      // The re-issue sees the source gone (a landed pre-drop rename), and the
      // reply that holds it is malformed: the guarded wrapper 'error' listener
      // kills the session before the probe is issued.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).fatalSftpError = new Error("Malformed DATA packet");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // A probe that reached this client would never answer, so the assertions
    // below stand only because none is issued.
    const probe = pendingExists(client);
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(probe.exists).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("bounds a re-issue probe whose answer the server withholds by the per-operation deadline", async () => {
    // The other prompt-failure guarantee: no fatal error, so the probe IS issued,
    // and the server simply never answers the stat. Without the adapter's own
    // per-operation bound the rename would hang to the whole-exchange budget.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({ stallDeadlineMs: 50 });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    // The probe was issued and timed out; the ambiguity it could not resolve
    // leaves the ORIGINAL rename error, not the stall, as the cause. One probe,
    // not two: an unanswered destination has already left the question open, so
    // the source is not asked and a second deadline is not spent.
    expect(probe.exists).toHaveBeenCalledOnce();
    expect(err).not.toBeInstanceOf(TransportOperationStalledError);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("reports an absent destination whose source is gone too as undetermined", async () => {
    // Both probes answer, and both answer false. That is NOT evidence the rename
    // failed: in delete mode the peer's consume-delete removes exactly this
    // party's own publish, so a rename that landed durably and was consumed
    // inside the recovery window reads identically to one that never landed. The
    // rejection stands -- nothing here reports an unpublished message as sent --
    // but as the undetermined outcome it is.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(false);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe(2);
    expect(sanitizeErrorForDisplay(err)).toContain("No such file");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // Renders the undetermined outcome of a rename into `toPath` exactly as a
  // terminal CLI error is rendered, so the assertions below read what an operator
  // would see rather than what went into the Error.
  async function renderUndeterminedPublish(toPath: string): Promise<string> {
    const wrapper = sessionWrapper();
    const { client, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("_rename: No such file or directory"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn().mockResolvedValue(false);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-msg.json", toPath)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    return sanitizeErrorForDisplay(err);
  }

  test("the undetermined publish's operative sentence outlives a destination that spends the display budget", async () => {
    // The rendering boundary, not the raw message: sanitizeErrorForDisplay is the
    // only path a terminal CLI error takes to a terminal, and it caps each link of
    // the cause chain at COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH. The sentence the
    // operator must act on -- that the publish MAY have arrived -- has to clear
    // that cap even against an ack name long enough to spend the whole budget,
    // since a truncation reaching it would leave prose asserting the opposite.
    const rendered = await renderUndeterminedPublish(
      `/remote/${"a".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH)}-ack.json`,
    );
    const [publishLink, ...causeLinks] = rendered.split("\ncaused by: ");
    expect(publishLink).toContain(
      "the publish may or may not have reached the partner",
    );
    // The truncation the cap does impose falls on the destination, which trails
    // the sentence rather than preceding it.
    expect(publishLink).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(publishLink.indexOf("Destination:")).toBeGreaterThan(
      publishLink.indexOf("may or may not"),
    );
    // The transport's own status is a separate link with a separate budget.
    expect(causeLinks.join("\n")).toContain(
      "_rename: No such file or directory",
    );
  });

  test("the undetermined publish escapes a destination carrying ANSI and a line break", async () => {
    // `toPath` is partner-derived on the ack and rendezvous rename paths (the ack
    // name's middle segments are unconstrained), so the destination is escaped
    // like every other path this app names in an error -- a hostile name must not
    // drive the operator's terminal or forge a log line.
    const rendered = await renderUndeterminedPublish(
      "/remote/\u001b[31mid\n2026-01-01 not a real log line-ack.json",
    );
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\n2026-01-01");
    expect(rendered).toContain("x1b[31mid");
    expect(rendered).toContain("x0a2026-01-01");
    expect(rendered).toContain(
      "the publish may or may not have reached the partner",
    );
  });

  test("reports the original rename error when the source is still on the server", async () => {
    // The other half of that pair: the destination is absent and the source is
    // still there, so nothing moved this party's file and the publish
    // determinately did not land. Its own error is reported, unwrapped -- the
    // undetermined classification must not swallow a determinate failure.
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      if (!state.live) throw notConnected("rename");
      throw Object.assign(new Error("rename: No such file From: a To: b"), {
        code: 2,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith("id-joining.json"),
      );
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    state.live = false;

    const err = await adapter
      .rename("/remote/id-joining.json", "/remote/id-hello.json")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransportPublishIndeterminateError);
    expect((err as NodeJS.ErrnoException).code).toBe(2);
    expect((err as Error).message).toContain("No such file");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("leaves a FIRST-attempt rename's absence and dest-exists conflict terminal, with no probe", async () => {
    // The idempotency relaxation is the RE-ISSUE's alone. On a live session there
    // is no session loss to recover from, so a genuine absence and a persistent
    // "operation did not take effect" both show up as themselves -- and neither
    // consults the destination, which is what would turn a real conflict into a
    // silent success.
    const wrapper = sessionWrapper();
    const { client, connect } = droppable(wrapper);
    // The raw numeric SFTP status ssh2-sftp-client passes through on `code`.
    let failure: Error & { code: number } = Object.assign(
      new Error("rename: No such file From: a To: b"),
      { code: 2 },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).rename = vi.fn().mockImplementation(async () => {
      throw failure;
    });
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    // retries: 0 holds the status-4 case to a single attempt; the retry budget
    // itself is pinned by the "rename retry" block.
    await adapter.connect({ host: "h", maxReconnectAttempts: 2, retries: 0 });

    await expect(
      adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json"),
    ).rejects.toThrow("No such file");

    failure = Object.assign(new Error("_rename: Failure"), { code: 4 });
    await expect(
      adapter.rename("/remote/temp-send.tmp", "/remote/id-0-12.json"),
    ).rejects.toThrow("_rename: Failure");

    expect(probe.exists).not.toHaveBeenCalled();
    // The session never dropped, so nothing re-dialed either.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("suppresses the heartbeat's beat while the re-issue probe is on the wire", async () => {
    // The default held-session mode is the one that arms the heartbeat, and
    // ssh2-sftp-client permits one operation at a time. The probe passes through
    // the same bracket that keeps the heartbeat's in-flight count, so a beat
    // falling while it is outstanding is suppressed rather than posted alongside
    // it. The control at the end runs the same clock over a settled probe.
    vi.useFakeTimers();
    try {
      const wrapper = sessionWrapper();
      const { client, state } = droppable(wrapper);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).rename = vi.fn().mockImplementation(async () => {
        if (!state.live) throw notConnected("rename");
        throw Object.assign(new Error("rename: No such file From: a To: b"), {
          code: 2,
        });
      });
      const probe = pendingExists(client);
      // A deadline well past the heartbeat interval, so the beat below is what
      // the probe outlives rather than its own bound.
      const adapter = new SSH2SFTPClientAdapter({
        stallDeadlineMs: SFTP_HEARTBEAT_INTERVAL_MS * 10,
      });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      state.live = false;

      const publish = adapter.rename(
        "/remote/id-joining.json",
        "/remote/id-hello.json",
      );
      await probe.issued;

      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS);
      expect(client.realPath).not.toHaveBeenCalled();

      probe.answer(true);
      await expect(publish).resolves.toBeUndefined();
      // Same idle stretch, nothing outstanding: the beat fires, so the
      // suppression above was the probe's doing and not a stopped heartbeat.
      await vi.advanceTimersByTimeAsync(SFTP_HEARTBEAT_INTERVAL_MS);
      expect(client.realPath).toHaveBeenCalledWith(".");

      await adapter.end();
    } finally {
      vi.useRealTimers();
    }
  });

  // A raw SFTPWrapper stand-in that serves an empty directory (EOF on the first
  // readdir), so each recovered list() re-dials and returns []. Used by the cap
  // tests to drive a series of clean drops through withSessionRecovery.
  const emptyDirWrapper = () =>
    sessionWrapper({
      opendir: (_p: string, cb: (e: Error | null, h: Buffer) => void) =>
        cb(null, Buffer.from("h")),
      readdir: (
        _h: Buffer,
        cb: (e: (Error & { code?: number }) | null, l?: unknown[]) => void,
      ) => cb(Object.assign(new Error("EOF"), { code: 1 })),
      close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    });

  test("recovers up to the cap, then fails the next drop terminally (default mode)", async () => {
    // max_reconnect_attempts caps the CUMULATIVE number of mid-exchange
    // reconnections in the default held-session mode. With a budget of 3, three
    // drops each recover; the fourth exhausts the budget and fails the exchange
    // terminally with the actionable message rather than re-dialing again.
    const { client, connect, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }
    // Three survived drops: budget spent exactly to the cap.
    expect(adapter.midExchangeReconnectCount).toBe(3);
    expect(connect).toHaveBeenCalledTimes(4); // initial + 3 recoveries

    // The fourth drop is refused: terminal UsageError, no further re-dial.
    state.live = false;
    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("max_reconnect_attempts=3");
    // Names the partner-server drop and both remedies, each by the name the
    // operator can actually reach: the flag and the config field.
    expect((err as Error).message).toContain("session-duration or idle limit");
    expect((err as Error).message).toContain("--connection-per-poll");
    expect((err as Error).message).toContain("connection_per_poll: true");
    // No re-dial for the refused drop, and the drop itself still counted: the
    // budget bounds sessions lost, and this one was lost.
    expect(connect).toHaveBeenCalledTimes(4);
    expect(adapter.midExchangeReconnectCount).toBe(4);
  });

  test("the cumulative budget does not reset on a successful op (no reset on progress)", async () => {
    // The budget is STRICTLY cumulative: a successful op between drops does not
    // reset the count. A session-capping server makes progress every cycle, so a
    // reset-on-progress budget would never bound it. Prove it by interleaving
    // drop-free (progressing) list()s between the drops and showing the cap is
    // still reached at the same cumulative drop count.
    const { client, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    // Drop #1 recovers.
    state.live = false;
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(1);
    // Progress: a successful op with no drop must NOT reset the count.
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(1);

    // Drop #2 recovers -- now at the cap.
    state.live = false;
    await adapter.list("/remote/dir");
    expect(adapter.midExchangeReconnectCount).toBe(2);
    // More progress between the drop and the exhausting drop.
    await adapter.list("/remote/dir");

    // Drop #3 exhausts the budget: reachable only because the intervening
    // successful ops did NOT reset the cumulative count.
    state.live = false;
    const err = await adapter.list("/remote/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("reconnection budget");
    // Two recovered and the third refused, all three counted as the sessions the
    // partner took.
    expect(adapter.midExchangeReconnectCount).toBe(3);
  });

  test("warns on the last permitted re-dial, even below the escalation interval", async () => {
    // The rate cadence alone leaves a hole at any budget under
    // SFTP_REDIAL_WARN_INTERVAL -- the default 3 included: the first drop warns,
    // the escalation step never fires, and the operator's next signal would be the
    // terminal error. So the last re-dial the budget permits always warns, saying
    // plainly that the next drop ends the exchange.
    const { client, state } = droppable(emptyDirWrapper());
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    // The shipped default: a budget well below the escalation interval.
    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      state.live = false;
      await adapter.list("/remote/dir");
    }

    // Two lines: the first drop and the last permitted re-dial, not one per drop
    // and not silence after the first.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(
      "2 further mid-exchange re-dials are allowed",
    );
    const last = warn.mock.calls[1][0] as string;
    expect(last).toContain(
      "That was the last re-dial allowed by max_reconnect_attempts=3",
    );
    expect(last).toContain("the next mid-exchange drop ends the exchange");

    // And the warning told the truth: the next drop is terminal.
    state.live = false;
    await expect(adapter.list("/remote/dir")).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  test("a teardown re-dial is exempt from the cap, uncounted and unwarned, and still lands", async () => {
    // The authenticated abort-marker write and the terminal-frame drain re-dial
    // during teardown. Even with the mid-exchange budget already exhausted, a
    // teardown re-dial (signaled by beginTeardown) is ALLOWED -- so the fast-fail
    // marker still lands -- and is neither counted nor warned (it is teardown
    // mechanics, not a survived mid-exchange drop).
    const wrapper = sessionWrapper();
    const { client, connect, state } = droppable(wrapper);
    let putCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn().mockImplementation(() => {
      if (!state.live) return Promise.reject(notConnected("put"));
      putCalls += 1;
      return Promise.resolve("ok");
    });
    const adapter = new SSH2SFTPClientAdapter();
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    // Budget 0: a NON-teardown drop would fail terminally on the first drop.
    await adapter.connect({ host: "h", retries: 0, maxReconnectAttempts: 0 });
    // Teardown begins (as close() and the abort-marker write both signal), then the
    // held session drops and the marker-style write is issued.
    adapter.beginTeardown();
    state.live = false;

    await expect(
      adapter.put(Buffer.from("abort"), "/remote/id-abort.tmp", { flags: "w" }),
    ).resolves.toBe("ok");
    // The re-dial happened despite the exhausted budget: the marker landed.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(putCalls).toBe(1);
    // ... and it was charged to neither reconnect metric and raised no warning.
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(adapter.reconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

// --- mid-exchange drop whose close the partner withholds ---------------------
//
// A partner server that drops the SFTP session mid-exchange and then withholds
// its connection close leaves the transport half-open -- this side's write half
// ended, no FIN back -- with ssh2-sftp-client's `sftp` property STILL SET, since
// the library clears it only from the ssh2 Client's 'close'. The operation on the
// wire cannot complete on a transport that sends nothing, so it rides the
// per-operation liveness deadline and rejects with the terminal stalled error.
// Recovery therefore reads the TRANSPORT rather than the session property: it
// forces the ended transport closed so the library clears the session, then
// re-dials and re-issues exactly as it does for a partner that closes. A stall
// over a transport that is still live stays terminal, which is the distinction
// these cases pin. Measured against a real ssh2 server (docs/spec/DEPENDENCY_PINS.md);
// the end-to-end exercise is test/integration/heldSessionWithheldClose.test.ts.

describe("mid-exchange drop against a partner that withholds its close", () => {
  interface WithheldCloseSocket {
    setKeepAlive: () => void;
    writableEnded: boolean;
    readableEnded: boolean;
    destroyed: boolean;
    destroy?: () => void;
  }

  // An ssh2-sftp-client stand-in modeling the pinned library against that partner.
  // `dropWithholdingClose` is the server's cut as ssh2 leaves it: a half of the
  // transport ended, the session property untouched, and no 'close' -- so nothing
  // clears the session until this side destroys the socket, which is what the
  // library's global 'close' listener answers. `clearsOnDestroy: false` models an
  // ssh2 that no longer emits that 'close'; omitting `destroy` from the socket
  // models one that no longer exposes destroy() at all.
  function withholdingPartner(
    options: { clearsOnDestroy?: boolean; withDestroy?: boolean } = {},
  ) {
    const state = { live: true };
    const session = {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
      on: vi.fn(),
    };
    const socket: WithheldCloseSocket = {
      setKeepAlive: () => {},
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
    };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const destroy = vi.fn(() => {
      socket.destroyed = true;
      if (options.clearsOnDestroy === false) return;
      state.live = false;
      rawClient.emit("close");
    });
    if (options.withDestroy !== false) socket.destroy = destroy;
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        socket.writableEnded = true;
      }),
    });
    // ssh2 mints a fresh socket per dial, so a re-dial leaves neither half ended.
    const connect = vi.fn().mockImplementation(async () => {
      state.live = true;
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
    });
    const client = {
      get sftp() {
        return state.live ? session : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    const dropWithholdingClose = (
      half: "writable" | "readable" = "writable",
    ) => {
      if (half === "writable") socket.writableEnded = true;
      else socket.readableEnded = true;
    };
    return { client, connect, socket, state, destroy, dropWithholdingClose };
  }

  // The rejection such a drop produces: the operation is never answered, so the
  // adapter's own per-operation deadline is what ends it.
  const stalled = () =>
    new TransportOperationStalledError(
      "SFTP file delete of /remote/x.json stalled: no response from the " +
        "server; refusing to wait on the server further",
    );

  // The adapter's own forced-close bound (not exported; a liveness safety check,
  // not a tunable).
  const FORCED_CLOSE_BOUND_MS = 1_000;

  function loggedAdapter() {
    const adapter = new SSH2SFTPClientAdapter();
    const log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = log;
    return { adapter, log };
  }

  // A delete that stalls on the drop and succeeds on the re-issue, the shape the
  // recovered operation takes.
  const stallingThenSucceedingDelete = (client: object) => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(stalled())
      .mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = del;
    return del;
  };

  test.each([
    { half: "writable" as const, flag: "writableEnded" },
    { half: "readable" as const, flag: "readableEnded" },
  ])(
    "recovers the drop and completes the operation when the transport's $flag half has ended",
    async ({ half }) => {
      const { client, connect, destroy, dropWithholdingClose } =
        withholdingPartner();
      const del = stallingThenSucceedingDelete(client);
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      dropWithholdingClose(half);

      await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();

      // The session could only be cleared from this side: the forced close ran
      // once, and the re-dial and re-issue followed it.
      expect(destroy).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledTimes(2);
    },
  );

  test("counts and warns the recovery as the mid-exchange drop it is, never as an idle release", async () => {
    const { client, dropWithholdingClose } = withholdingPartner();
    stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    dropWithholdingClose();
    await adapter.delete("/remote/x.json");

    // A survived server-side drop, counted in both metrics exactly as a drop the
    // partner closed cleanly is.
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    // The connection-per-poll idle release's own accounting is untouched: this
    // boundary was a partner-side drop, not a release.
    expect(adapter.forcedReleaseCount).toBe(0);
    expect(adapter.declinedReleaseCount).toBe(0);

    // The existing mid-exchange drop warning, default-mode arm: it names the
    // partner's session cap and points at connection-per-poll, which is the right
    // advice for a server that behaves this way.
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("dropped mid-exchange and was transparently");
    expect(message).toContain("session-duration or idle limit");
    expect(message).toContain("--connection-per-poll");
    expect(message).toContain("max_reconnect_attempts=3");
    // Not the idle release's line, which reports a boundary this mode never has.
    expect(message).not.toContain("idle release");
  });

  test("charges the drop to max_reconnect_attempts, and an exhausted budget is terminal", async () => {
    const { client, connect, state, socket, dropWithholdingClose } =
      withholdingPartner();
    // Every attempt stalls the way the drop does; only the re-dial restores the
    // session, so each drop costs exactly one re-dial.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockImplementation(async () => {
      if (socket.writableEnded) throw stalled();
    });
    const { adapter } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    dropWithholdingClose();
    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // The budget is spent, so the next such drop fails terminally with the
    // existing actionable message and no further re-dial.
    dropWithholdingClose();
    const err = await adapter.delete("/remote/x.json").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("max_reconnect_attempts=1");
    expect((err as Error).message).toContain("--connection-per-poll");
    expect(connect).toHaveBeenCalledTimes(2);
    // The refused drop was still a session lost, and the budget bounds those.
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(state.live).toBe(true);
  });

  test("leaves a stall on a live, still-writable transport terminal", async () => {
    // The stall exclusion keeps its whole force wherever the transport has not
    // ended: re-dialing on a timeout would hand a withholding server a free
    // liveness reset, and nothing here says the session was lost.
    const { client, connect, destroy } = withholdingPartner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn().mockRejectedValue(stalled());
    const { adapter } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("recovers a partner that DOES close with no forced close and no extra dial", async () => {
    // The library cleared the session itself, so there is nothing to force: the
    // recovery is the one it has always been, with no added wait and no second
    // mechanism driven.
    const { client, connect, destroy, state } = withholdingPartner();
    const del = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("delete: No SFTP connection available"), {
          code: "ERR_NOT_CONNECTED",
        }),
      )
      .mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = del;
    const { adapter } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    // The partner closed the connection: ssh2-sftp-client's global 'close'
    // listener cleared the session property.
    state.live = false;

    await expect(adapter.delete("/remote/x.json")).resolves.toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the socket destroy() call site has moved", async () => {
    // The mechanism is checked, not assumed: with the call site gone the recovery
    // cannot clear the session, so it says so -- naming the call site and the upgrade
    // checklist -- and degrades to the terminal outcome the operation already had,
    // in the same error class the poll loop stops on.
    const { client, connect, dropWithholdingClose } = withholdingPartner({
      withDestroy: false,
    });
    const del = stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    dropWithholdingClose();

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    // The operation was not re-issued onto the session that can send nothing.
    expect(del).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("could not be re-opened");
    expect(message).toContain("not compatible with the installed SFTP library");
    // The ssh2 internal that moved is contributor-tier detail, so it is logged
    // at debug rather than put on the operator's terminal.
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("client._sock.destroy()"),
    );
    // Nothing was recovered, and the session was lost all the same: the counters
    // report sessions lost rather than recoveries completed.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the forced close's destroy raises", async () => {
    // net.Socket's destroy() is driven synchronously, so it can raise INTO the
    // recovery rather than rejecting a wait it can absorb. The recovery catches
    // that where the connection-per-poll release does not, by design: the
    // operation already holds the loss the poll loop stops on, and an error of
    // the mechanism's own would replace it with one the loop reads differently.
    const { client, connect, destroy, dropWithholdingClose } =
      withholdingPartner();
    destroy.mockImplementation(() => {
      throw new Error("socket already destroyed");
    });
    const del = stallingThenSucceedingDelete(client);
    const { adapter, log } = loggedAdapter();
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    dropWithholdingClose();

    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(destroy).toHaveBeenCalledOnce();
    // The session never cleared, so there is nothing to re-dial or re-issue onto.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("socket already destroyed");
    // A destroy that raises is the shape a change in ssh2's teardown semantics
    // reaches the operator as, so this warning names the same suspect its two
    // sibling failures do.
    expect(message).toContain(
      "may not be compatible with the installed SFTP library",
    );
    // Counted as the lost session it was, whether or not the re-dial for it ran.
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("warns and leaves the operation terminal when the forced close does not clear the session", async () => {
    // The one assumption no dial can check -- that destroying the transport takes the
    // session with it -- is read back where it is driven, on the mid-exchange
    // path's own terms: a warning and the operation's own loss, not a raise of its
    // own that would replace it.
    vi.useFakeTimers();
    try {
      const { client, connect, destroy, dropWithholdingClose } =
        withholdingPartner({ clearsOnDestroy: false });
      const del = stallingThenSucceedingDelete(client);
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
      dropWithholdingClose();

      const failing = adapter.delete("/remote/x.json").catch((e: unknown) => e);
      // The forced close waits out its own bound for a 'close' that never lands.
      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);

      expect(await failing).toBeInstanceOf(TransportOperationStalledError);
      expect(destroy).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledOnce();
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close within");
      expect(message).toContain(
        "may not be compatible with the installed SFTP library",
      );
      // Counted as the lost session it was, whether or not the re-dial for it ran.
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
