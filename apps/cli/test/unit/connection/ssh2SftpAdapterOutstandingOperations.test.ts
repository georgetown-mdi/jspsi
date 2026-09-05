// What an operation still on the wire does to a session transition.

import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { describe, expect, test, vi } from "vitest";
import {
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { SFTP_PUT_PROGRESS_CHUNK_BYTES } from "../../../src/connection/sftpLivenessGuard";
import {
  adapterLog,
  boundarySaysReleaseTookTheSession,
  captureAdapterLog,
  ephemeralClient,
  installClient,
  notConnected,
  outstandingOperations,
  pendingExists,
  releasableClient,
  releaseBoundaryStands,
  withheldCloseClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

describe("an operation outstanding across a session transition", () => {
  // The cases below pin what the adapter DOES across a session transition --
  // which boundary is a deliberate release and which is a server-side drop, and
  // what a teardown may overlap -- through the reconnect counters, the operator
  // warning, and the call sites the adapter drives. None of them reads the adapter's
  // internal bookkeeping, so each holds whatever machinery serializes the
  // transitions underneath.

  // The SSH_FX_NO_SUCH_FILE status ssh2-sftp-client reports as the raw numeric
  // SFTP code, which the delete and rename recovery resolvers read to tell a
  // pre-drop attempt that already LANDED from a genuine absence.
  const noSuchFile = (name: string) =>
    Object.assign(new Error(`${name}: No such file`), { code: 2 });

  // A client whose data-plane ops are outstanding for one macrotask -- the server
  // round trip a release can fall in the middle of -- and whose ssh2 Client end()
  // tears whichever is on the wire, exactly as ssh2-sftp-client's per-operation
  // listeners do. An op torn that way ALREADY LANDED on the server (the request
  // reached it; only the reply was lost), so its re-issue sees the post-op state:
  // the deleted source absent, the renamed source absent with the destination
  // present. That is the state the recovery resolvers exist to read.
  //
  // `schedule` is called in the same turn as the re-issue's own rejection, which
  // is the only place a test can hand work to the exact microtask queue that
  // rejection drains: the recovery arm's remaining hops are queued from there,
  // so a continuation queued alongside them interleaves with the arm rather than
  // landing before or after the whole of it.
  function landedOnTearClient(
    wrapper: ReturnType<typeof wrapperMethods>,
    schedule: () => void = () => {},
  ) {
    const state = { live: true, ending: false };
    const landed = new Set<string>();
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    // destroy() needs nothing from the peer, and the ssh2 Client's 'close' that
    // follows is what fires ssh2-sftp-client's global listener to clear the
    // session. A stand-in that drove neither leaves a retirement of a session
    // still held over an ended transport failing for want of a mock.
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      destroy: vi.fn(() => {
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        state.ending = true;
        state.live = false;
        failInFlight?.(notConnected("operation"));
        failInFlight = undefined;
        setTimeout(() => {
          state.ending = false;
          rawClient.emit("close");
        }, 0);
      }),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.ending)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      socket.writableEnded = false;
      state.live = true;
    });
    // One server round trip: it lands on the far side unless the transport is
    // already gone, and a tear rejects the caller AFTER the server applied it.
    const roundTrip = (name: string, path: string, apply: () => void) =>
      new Promise<void>((resolve, reject) => {
        if (!state.live) {
          reject(notConnected(name));
          return;
        }
        if (landed.has(path)) {
          // A server answers a re-issue with a round trip of its own, so the
          // rejection lands a macrotask later rather than inside this executor.
          setTimeout(() => {
            reject(noSuchFile(name));
            schedule();
          }, 0);
          return;
        }
        const answer = setTimeout(() => {
          apply();
          resolve();
        }, 0);
        failInFlight = (error: unknown) => {
          clearTimeout(answer);
          apply();
          reject(error);
        };
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      delete: vi.fn((path: string) =>
        roundTrip("delete", path, () => landed.add(path)),
      ),
      rename: vi.fn((fromPath: string, toPath: string) =>
        roundTrip("rename", fromPath, () => {
          landed.add(fromPath);
          landed.add(toPath);
        }),
      ),
      exists: vi.fn(async (path: string) => {
        if (!state.live) throw notConnected("exists");
        return landed.has(path);
      }),
    };
    // The PARTNER dropping a session with an operation on the wire: it fails that
    // operation and clears the session exactly as the ssh2 'close' handler does,
    // with no end() of this side's. The tear the recovery resolvers are for, driven
    // by the only thing that still produces it.
    const dropFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected("operation"));
      failInFlight = undefined;
      rawClient.emit("close");
    };
    // The same drop from a partner that withholds its CONNECTION close: only the
    // SFTP channel goes, so the operation -- which LANDED before the channel did --
    // is rejected over a transport ssh2 has ended while neither ssh2-sftp-client
    // listener that clears `sftp` has run. The session property therefore still
    // reads live, which is what leaves a release something to close.
    const tearChannelWithholdingClose = () => {
      socket.writableEnded = true;
      failInFlight?.(new Error("operation: channel is closed"));
      failInFlight = undefined;
    };
    return {
      client,
      connect,
      state,
      rawClient,
      socket,
      landed,
      dropFromServer,
      tearChannelWithholdingClose,
    };
  }

  // Replaces a client's delete with one the test settles by hand, so an operation
  // can be left OUTSTANDING across a transition. What the boundary precondition
  // reads is the wire, so every case below has to put something on it and leave it
  // there.
  function pendingDelete(client: object) {
    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).delete = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveOperation = () => resolve();
          rejectOperation = reject;
        }),
    );
    return {
      settle: () => resolveOperation(),
      fail: (error: unknown) => rejectOperation(error),
    };
  }

  test("a delete torn off the wire by a server drop resolves through its recovery resolver", async () => {
    // The tear that survives the boundary precondition: the PARTNER drops the
    // session with the delete on the wire. The default held-session mode is where
    // this lands -- it runs no idle release at all -- and the resolver is what
    // handles it: re-dial, re-issue, and the now-absent source read as the landed
    // attempt it was. The drop is the server's, so it is counted and warned.
    const { client, connect, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const removal = adapter.delete("/remote/out.json");
    dropFromServer();

    await expect(removal).resolves.toBeUndefined();
    expect(landed.has("/remote/out.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a rename torn off the wire by a server drop resolves through its recovery resolver", async () => {
    // The same tear on the publish that matters most: a temp-file rename to its
    // final name. The re-issue sees the source gone, confirms the self-prefixed
    // destination present, and reports the landed publish as the success it was.
    const { client, connect, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("a rename torn by a partner that withholds its connection close recovers on a transport the re-dial retires itself", async () => {
    // The same landed publish, torn by a partner that drops only the SFTP
    // channel: the session property is left set over a transport ssh2 has ended,
    // which the library's connect() will not dial past. Nothing else clears it
    // here -- no release runs -- so the re-dial's own retirement is what has to,
    // forcing the ended transport closed for the client 'close' that clears the
    // session, and the re-issue then reads the landed rename exactly as it does
    // after a drop that closed.
    const {
      client,
      connect,
      rawClient,
      socket,
      landed,
      tearChannelWithholdingClose,
    } = landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    tearChannelWithholdingClose();

    await expect(publish).resolves.toBeUndefined();
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The forced close is the retirement's own: the ssh2 Client's end() is driven
    // by a release in this mock and by nothing else, and no release runs here.
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  // A client modeling what a partner-side drop does to a HIGH-LEVEL operation in
  // flight, which is a different sequence from the raw-wrapper tear above.
  // ssh2-sftp-client's per-operation listeners clear the session and reject the
  // operation from the ssh2 Client's 'end', a full event ahead of the 'close' the
  // transport still owes -- so recovery is entered with the session already gone
  // and a lifecycle event of the dead transport still to come. The library's own
  // connect-time listeners fail any dial that stale event reaches, which is what
  // `connect` refuses here, and the handshake such a dial started runs on unowned
  // at the server. The 'close' lands when this side destroys the socket: the state
  // under test is a transport that still owes it when recovery runs, so the mock
  // holds that state until the adapter acts on it.
  function tornOnEndClient(wrapper: ReturnType<typeof wrapperMethods>) {
    const state = { live: true, closeOwed: false };
    let failInFlight: ((error: unknown) => void) | undefined;
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
      destroy: vi.fn(() => {
        socket.destroyed = true;
        if (!state.closeOwed) return;
        state.closeOwed = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(),
    });
    const connect = vi.fn().mockImplementation(async () => {
      if (state.closeOwed)
        throw new Error("getConnection: Unexpected close event");
      // ssh2 mints a fresh socket per dial, so neither half is ended on it.
      state.live = true;
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
    });
    // One server round trip, outstanding for a macrotask, which the drop tears.
    const roundTrip = <T>(name: string, value: T) =>
      new Promise<T>((resolve, reject) => {
        if (!state.live) {
          reject(notConnected(name));
          return;
        }
        const answer = setTimeout(() => resolve(value), 0);
        failInFlight = (error: unknown) => {
          clearTimeout(answer);
          reject(error);
        };
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      get: vi.fn(() => roundTrip("get", Buffer.from("payload"))),
      put: vi.fn(() => roundTrip("put", "ok")),
      exists: vi.fn(() => roundTrip("exists", true)),
    };
    // The partner's clean cut, as the pinned library delivers it to a high-level
    // operation: the session property is cleared and the operation rejected from
    // the 'end', with the 'close' still owed.
    const dropFromServer = () => {
      state.live = false;
      state.closeOwed = true;
      socket.writableEnded = true;
      socket.readableEnded = true;
      failInFlight?.(notConnected("operation"));
      failInFlight = undefined;
      rawClient.emit("end");
    };
    return { client, connect, rawClient, socket, dropFromServer };
  }

  test.each([
    {
      op: "get" as const,
      run: (a: SSH2SFTPClientAdapter) => a.get("/r/x.json"),
    },
    {
      op: "put" as const,
      run: (a: SSH2SFTPClientAdapter) =>
        a.put(Buffer.from("payload"), "/r/x.json"),
    },
    {
      op: "exists" as const,
      run: (a: SSH2SFTPClientAdapter) => a.exists("/r/x.json"),
    },
  ])(
    "a $op torn in flight by a server drop recovers on ONE re-dial, with no dial issued into the owed close",
    async ({ run }) => {
      // The high-level ops reject on the 'end', so recovery runs while the dead
      // transport still owes its 'close'. Dialing there fails the dial and leaves
      // the session it opened abandoned at the server, and that session's own
      // later events fail the next dial in turn -- so the whole budget burns out
      // and the operation reports a connect error instead of its session loss.
      // The recovery retires the transport first, so the one dial it makes lands.
      const { client, connect, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter();
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 3 });

      const operation = run(adapter);
      dropFromServer();

      await expect(operation).resolves.not.toBeUndefined();
      // Exactly one re-dial: no attempt was spent on a dial the owed close would
      // have failed, so none left an abandoned session behind either.
      expect(connect).toHaveBeenCalledTimes(2);
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    },
  );

  test("warns and leaves the operation terminal when the owed close never lands", async () => {
    // The assumption the retirement rests on -- that destroying the transport draws
    // the client 'close' -- is read back where it is driven, like its two siblings
    // on this path: a warning naming the checklist, no dial, and the operation's
    // own session loss rather than an error of the mechanism's making.
    vi.useFakeTimers();
    try {
      const { client, connect, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      socket.destroy = vi.fn(() => {
        socket.destroyed = true;
      });
      const warn = vi.fn();
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
      const failing = adapter.exists("/r/x.json").catch((e: unknown) => e);
      dropFromServer();
      // Past the retirement's own bound for a 'close' that never lands, and past
      // the whole dialing-retry budget besides, so what the recovery decided
      // determines the outcome here, not a wait still outstanding.
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await failing;
      expect((error as { code?: unknown }).code).toBe("ERR_NOT_CONNECTED");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledOnce();
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close within");
      expect(message).toContain(
        "may not be compatible with the installed SFTP library",
      );
      // Nothing was recovered, and nothing is reported as recovered; the session
      // was lost all the same, which is what the counter reports.
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Takes the lifecycle watch's call site away from a Client, leaving the call
  // sites the retirement DRIVES intact: EventEmitter's own once() is implemented
  // in terms of on(), so a hand-rolled substitute is what separates the reading's
  // call site from the forced close's rather than removing both at once.
  function withoutClientOn(rawClient: EventEmitter & Record<string, unknown>) {
    const attach = rawClient.on.bind(rawClient);
    const once = (
      event: string,
      listener: (...args: unknown[]) => void,
    ): EventEmitter => {
      const wrapped = (...args: unknown[]): void => {
        rawClient.removeListener(event, wrapped);
        listener(...args);
      };
      attach(event, wrapped);
      return rawClient;
    };
    Object.assign(rawClient, { once, on: undefined });
  }

  // The retirement's report that it had no lifecycle reading to take, picked out of
  // the warnings the recovery itself raises alongside it.
  function unreadableLifecycleWarnings(
    warn: ReturnType<typeof vi.fn>,
  ): string[] {
    return warn.mock.calls
      .map((call) => call[0] as string)
      .filter((message) =>
        message.includes("Every mid-exchange re-dial on this SFTP connection"),
      );
  }

  test("a Client whose on() has moved still recovers the torn operation, warning for the reading it lost", async () => {
    // The transport-lifecycle watch is best-effort, but its absence is "cannot
    // tell", never "nothing owed": with no reading to take, the re-dial retires the
    // transport rather than dialing into a window it cannot see -- so the torn
    // operation still recovers on ONE dial, and the lost reading is reported as the
    // call site failure it is instead of being spent silently on a failed dial.
    const { client, connect, rawClient, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    withoutClientOn(rawClient);
    const warn = vi.fn();
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
    const operation = adapter.exists("/r/x.json");
    dropFromServer();

    await expect(operation).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(adapter.midExchangeReconnectCount).toBe(1);
    const lostReading = unreadableLifecycleWarnings(warn);
    expect(lostReading).toHaveLength(1);
    // A latency cost only, so it says the exchange still completes rather than
    // borrowing the terminal failures' "not compatible".
    expect(lostReading[0]).toContain("The exchange still completes.");
    expect(lostReading[0]).toContain(
      "does not fully support the installed SFTP library",
    );
  });

  test("a Client whose on() has moved pays the forced close's bound where the drop had already run its whole sequence", async () => {
    // The cost of reading an absent lifecycle as "cannot tell": the neighbouring
    // class, whose 'close' has already landed, no longer takes the shortcut the
    // reading would have licensed. It closes a transport that had already closed
    // and rides the forced close's whole bound -- a 'close' listener armed after
    // the event never resolves early -- before dialing. The drop still recovers on
    // one dial; only the wait is added, and only here.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      withoutClientOn(rawClient);
      const adapter = new SSH2SFTPClientAdapter();
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      dropFromServer();
      // The partner's close arrives before anything else is issued, so nothing is
      // owed -- which is exactly what this Client cannot be asked.
      socket.destroy();
      socket.destroy.mockClear();

      const operation = adapter.exists("/r/x.json");
      // Everything that can settle without a timer expiring has settled.
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(socket.destroy).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(operation).resolves.toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.midExchangeReconnectCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a Client whose on() has moved warns once however many drops it recovers", async () => {
    // Whether the Client exposes on() is the installed version's property, not the
    // drop's, so the second recovery repeats the wait and not the warning.
    const { client, connect, rawClient, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    withoutClientOn(rawClient);
    const warn = vi.fn();
    const adapter = new SSH2SFTPClientAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 4 });
    const first = adapter.exists("/r/x.json");
    dropFromServer();
    await expect(first).resolves.toBe(true);
    const second = adapter.exists("/r/y.json");
    dropFromServer();
    await expect(second).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(unreadableLifecycleWarnings(warn)).toHaveLength(1);
  });

  test("a Client with no EventEmitter surface at all refuses the re-dial and leaves the operation its own loss", async () => {
    // The whole surface gone, which is what relocating it actually looks like: the
    // reading is unavailable AND so is the forced close the conservative branch
    // falls through to. Both are reported, no dial is spent on a window nothing can
    // see, and the operation fails with the session loss it already had rather than
    // with a connect error of the recovery's making.
    vi.useFakeTimers();
    try {
      const { client, connect, rawClient, socket, dropFromServer } =
        tornOnEndClient(wrapperMethods());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rawClient as any).on = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rawClient as any).once = undefined;
      const warn = vi.fn();
      const adapter = new SSH2SFTPClientAdapter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).log = {
        warn,
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
      };
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 1 });
      const failing = adapter.exists("/r/x.json").catch((e: unknown) => e);
      dropFromServer();
      // Past the retirement's own bound and the whole dialing-retry budget, so
      // what the recovery decided determines the outcome here, not a wait still
      // outstanding.
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await failing;
      expect((error as { code?: unknown }).code).toBe("ERR_NOT_CONNECTED");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();
      // The re-dial was refused, and the session was lost regardless.
      expect(adapter.midExchangeReconnectCount).toBe(1);
      const messages = warn.mock.calls.map((call) => call[0] as string);
      expect(unreadableLifecycleWarnings(warn)).toHaveLength(1);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain("could not be re-opened");
      // The lost reading costs latency and the refused re-dial costs the
      // operation, so only the second claims an incompatible library.
      expect(messages[0]).toContain(
        "does not fully support the installed SFTP library",
      );
      expect(messages[1]).toContain(
        "not compatible with the installed SFTP library",
      );
      for (const message of messages) {
        expect(message).toContain("'psilink --version'");
        expect(message).toContain(
          "https://github.com/georgetown-mdi/jspsi/issues",
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a drop that lands BEFORE the operation is issued still recovers on one re-dial", async () => {
    // The neighbouring class, kept apart from the in-flight tear above: the whole
    // lifecycle sequence has run by the time the operation is issued, so there is
    // nothing owed and the retirement drives nothing at all. The re-dial is the
    // one it has always been.
    const { client, connect, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    dropFromServer();
    // The partner's close arrives before anything else is issued.
    socket.destroy();
    socket.destroy.mockClear();

    await expect(adapter.exists("/r/x.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("the re-dial stops the keepalive, then retires the transport, then dials", async () => {
    // The order the whole recovery rests on, asserted as an order rather than as
    // three outcomes that a reordering would leave individually intact. Retiring
    // AFTER the dial would put the dial in the window the retirement exists to
    // clear, and it is the retirement's close that settles whatever else the drop
    // left on that transport, so an operation concurrent with this one would be
    // left for its own liveness deadline instead. Stopping the keepalive after
    // either would let the dropped session's still-armed timer post a realPath
    // onto a transport this is about to destroy, or onto a handshake in progress.
    const { client, connect, socket, dropFromServer } =
      tornOnEndClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 3 });
    // Spied after the first dial, so the arming that dial does is not what the
    // reading below picks up.
    const stopKeepalive = vi.spyOn(
      (adapter as unknown as { heartbeat: { stop: () => void } }).heartbeat,
      "stop",
    );
    connect.mockClear();

    const operation = adapter.exists("/r/x.json");
    dropFromServer();
    await expect(operation).resolves.toBe(true);

    // Vitest stamps every mock call with a run-wide sequence number, which is what
    // orders calls on three separate mocks against each other.
    const [stopped] = stopKeepalive.mock.invocationCallOrder;
    const [retired] = socket.destroy.mock.invocationCallOrder;
    const [dialed] = connect.mock.invocationCallOrder;
    expect(stopped).toBeLessThan(retired);
    expect(retired).toBeLessThan(dialed);
    expect(connect).toHaveBeenCalledOnce();
    expect(adapter.midExchangeReconnectCount).toBe(1);
  });

  test("an idle boundary reached with an operation outstanding does not close the session, and the operation completes on the session it was issued against", async () => {
    // The one operation no entry gate can cover: it is already on the wire when
    // the idle boundary falls. The release reads that off the adapter's own
    // outstanding-operation count and keeps the session, so the delete answers on
    // the very session it was issued against -- no tear, no recovery round, and
    // nothing for the reconnect counters or the operator warning.
    const { client, connect, rawClient, state, landed } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    // No reconnection budget at all, so a re-dial charged to the exchange would
    // fail the operation outright rather than being quietly absorbed.
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const removal = adapter.delete("/remote/out.json");
    const release = adapter.releaseForIdle();
    // Read with no await between it and the call above: the release drove nothing.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    await expect(release).resolves.toBeUndefined();
    await expect(removal).resolves.toBeUndefined();

    expect(landed.has("/remote/out.json")).toBe(true);
    // The initial dial and nothing more: the operation neither lost a session nor
    // recovered one.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an idle boundary reached while a rename re-issue's probe is on the wire holds the session, and the landed rename resolves as landed", async () => {
    // The probe that confirms a landed pre-drop rename is a server round trip of
    // this adapter's own, counted at the same bracket as the rename it settles.
    // A boundary falling while it is outstanding therefore closes nothing: a
    // release that tore it would leave the probe unable to answer, and an
    // unanswered probe reports a rename that DID land as the failure that drove
    // it -- a publish lost to a session this side closed on purpose.
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    // The partner drops the session with the rename on the wire: it landed on the
    // server, so the re-issue after the recovery re-dial sees the source gone and
    // fires the probe.
    dropFromServer();
    await probe.issued;

    // The recovery arm counts the unsettled rename for the whole of itself and the
    // probe's own bracket nests inside that span, so the same operation is counted
    // more than once while the probe is on the wire. Read the way the release's
    // precondition reads it -- non-zero, never a quantity -- so what pins the state
    // the release is entered against is that reading and not the nesting depth.
    expect(outstandingOperations(adapter)).toBeGreaterThan(0);
    const release = adapter.releaseForIdle();
    // Read with no await between it and the call above: the release drove nothing.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    await expect(release).resolves.toBeUndefined();
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);

    // The server applied the rename before the tear, so the probe finds the
    // destination present and the publish is reported as the success it was.
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    probe.answer(true);
    await expect(publish).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // Enter an idle release at the boundary between the re-issued attempt's reply
  // and the destination probe it fires.
  //
  // Entered from the same turn as that reply -- the only place a test can hand
  // work to the exact microtask queue the rejection drains -- and called
  // synchronously there: an idle transition queue is entered in the calling tick,
  // so the boundary falls with the re-issue's rejection queued and its probe not
  // yet issued. There is no count for the device to watch for: the
  // operation is one span from issue to final settlement, so the count reads the
  // same at this boundary as it does anywhere else in the arm, which is the property
  // the case is for.
  //
  // Reports whether it arrived: a device the mock never called would leave the
  // case asserting nothing, so the case asserts it arrived.
  function releaseAtTheReissueSeam(adapter: SSH2SFTPClientAdapter) {
    let reached = false;
    const schedule = (): void => {
      reached = true;
      void adapter.releaseForIdle();
    };
    return { schedule, reached: () => reached };
  }

  test("an idle boundary landing between the rename re-issue and its probe closes nothing, and the landed rename still resolves", async () => {
    // The boundary the recovery arm's bracket exists for. The re-issue after the
    // re-dial sees the source gone -- the pre-drop rename LANDED -- and fires the
    // destination probe that says so. Its own bracket closes the count before the
    // probe's opens, and a release entering there would close the session the
    // probe has yet to answer on: the unanswered probe is treated as "the rename
    // did not land", and a publish that reached the server fails terminally on the
    // SSH_FX_NO_SUCH_FILE that drove the probe. The arm holds the count across the
    // whole of itself, so the boundary is held rather than closed.
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 300,
    });
    const seam = releaseAtTheReissueSeam(adapter);
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods(), seam.schedule);
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    expect(seam.reached()).toBe(true);
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The release closed nothing: the only thing that drives the ssh2 Client's
    // end() in this mock is the release itself.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    // One re-dial for the drop, and none for a session a boundary took away.
    expect(connect).toHaveBeenCalledTimes(2);
    // The boundary the arm held is accounted exactly as a boundary held for an
    // ordinary operation is.
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
  });

  test("an idle boundary landing between the recovery re-dial and the re-issue closes nothing, and the landed rename still resolves", async () => {
    // The other span the arm's bracket covers. The re-dial has established the
    // replacement session and the re-issue has not run on it yet; a release
    // entering there would close the very session just dialed, and the re-issue
    // would then reject with a dead-session error no recovery resolver reads at
    // all -- so a rename that DID land shows up as a failed publish, the same
    // outcome as at the probe boundary and by a different route.
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 300,
    });
    const { client, connect, rawClient, state, landed, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    // Entered from inside the recovery re-dial, then advanced one microtask at a
    // time until that re-dial has left the transition queue: the release is
    // requested with the queue free, so it enters in the calling tick rather than
    // taking a slot behind the re-dial and landing past the re-issue. Requesting
    // it from inside the re-dial instead lands there every time, and measures
    // nothing -- the re-issue's own bracket holds the boundary by then whether or
    // not the arm keeps a span.
    let dials = 0;
    const boundary = { attemptsAtEntry: -1, entered: false };
    const dial = connect.getMockImplementation()!;
    connect.mockImplementation(async () => {
      dials += 1;
      await dial();
      if (dials !== 2) return;
      void (async () => {
        while (pendingSessionTransitions(adapter) > 0) await Promise.resolve();
        boundary.attemptsAtEntry = (
          client.rename as ReturnType<typeof vi.fn>
        ).mock.calls.length;
        const held = adapter.heldBoundaryCount;
        void adapter.releaseForIdle();
        boundary.entered = adapter.heldBoundaryCount !== held;
      })();
    });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();

    await expect(publish).resolves.toBeUndefined();
    // The boundary landed in the window and nowhere else: it was entered in its
    // caller's own tick, with the first attempt the only rename issued so far. A
    // boundary that fell past the re-issue would be held by the re-issue's own
    // bracket and would measure nothing about the arm's span.
    expect(boundary.entered).toBe(true);
    expect(boundary.attemptsAtEntry).toBe(1);
    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    // The release closed nothing: the only thing that drives the ssh2 Client's
    // end() in this mock is the release itself.
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    // One re-dial for the drop, and none for a session a boundary took away.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.heldBoundaryCount).toBe(1);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
  });

  test("a landed rename torn mid-publish resolves with every boundary across its arm held", async () => {
    // The publish this span exists for. A rename that DID land is torn before its
    // reply arrives, and what tells the adapter it landed is the re-issue's own
    // error plus the destination probe behind it -- both inside the arm. A
    // boundary closing anywhere across that arm would close the session the
    // re-issue and the probe run on, and the landed publish would show up as a
    // failure. Swept across the arm rather than placed at one point: the span
    // covers the whole of it, so every depth reads the operation counted and is
    // held.
    const depths = 40;
    for (let depth = 0; depth < depths; depth += 1) {
      const {
        client,
        connect,
        rawClient,
        state,
        landed,
        tearChannelWithholdingClose,
      } = landedOnTearClient(wrapperMethods());
      const adapter = new SSH2SFTPClientAdapter({
        ephemeralSessions: true,
        stallDeadlineMs: 300,
      });
      captureAdapterLog(adapter);
      installClient(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const publish = adapter.rename(
        "/remote/temp-send.tmp",
        "/remote/id-0-12.json",
      );
      // The partner drops the SFTP channel while withholding its connection close,
      // which is what would leave a release a session to close at all: a drop that
      // had already cleared the session would leave it nothing to do, so this is
      // the shape that can actually take a session away mid-arm.
      tearChannelWithholdingClose();
      for (let tick = 0; tick < depth; tick += 1) await Promise.resolve();
      const release = adapter.releaseForIdle();

      await expect(publish, `depth ${depth}`).resolves.toBeUndefined();
      await expect(release, `depth ${depth}`).resolves.toBeUndefined();
      expect(landed.has("/remote/id-0-12.json"), `depth ${depth}`).toBe(true);
      // Nothing closed: the boundary was held for the operation still in its arm.
      expect(rawClient.end, `depth ${depth}`).not.toHaveBeenCalled();
      expect(adapter.heldBoundaryCount, `depth ${depth}`).toBe(1);
      // The arm's own re-dial is the only one, and it left a live session behind.
      expect(connect, `depth ${depth}`).toHaveBeenCalledTimes(2);
      expect(state.live, `depth ${depth}`).toBe(true);
    }
  });

  test("the boundary held for the rename probe is bounded by the probe's own deadline, and the next boundary releases", async () => {
    // The composition the two halves above only prove in pieces: one boundary
    // falls while the probe is on the wire and is held, and what ends that hold
    // is the probe's per-operation deadline and nothing weaker. The count returns
    // to zero with the stat still outstanding at the server, and the next
    // boundary closes as an undisturbed one does -- so counting the probe buys
    // the hold no bound the rest of the bracket does not already have.
    const { client, rawClient, state, dropFromServer } =
      landedOnTearClient(wrapperMethods());
    const probe = pendingExists(client);
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 200,
    });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    dropFromServer();
    await probe.issued;

    // The arm's span around the unsettled rename, with the probe's own bracket
    // nested inside it (see the case above), read as the non-zero the release's
    // precondition reads. What this case measures is the DROP to zero below, which
    // the nesting depth is no part of.
    expect(outstandingOperations(adapter)).toBeGreaterThan(0);
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    // The probe is never answered: its deadline is what settles it, and the
    // ORIGINAL rename error is what the rejection holds rather than the probe's
    // own stall.
    const err = await publish.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(sanitizeErrorForDisplay(err)).toContain("No such file");
    expect(probe.exists).toHaveBeenCalledOnce();
    expect(outstandingOperations(adapter)).toBe(0);

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("an operation outstanding at the boundary never reaches the stall-deadline or the session-still-live terminal reading", async () => {
    // The publish that matters most -- a temp-file rename to its final name --
    // outstanding when the boundary falls. Held rather than torn, it reaches the
    // recovery path not at all, so neither of that path's terminal readings is on
    // its account: no re-dial is issued for it, and it does not reject.
    const { client, connect, rawClient, landed } =
      landedOnTearClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    const warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).log = {
      warn,
      trace: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const publish = adapter.rename(
      "/remote/temp-send.tmp",
      "/remote/id-0-12.json",
    );
    const release = adapter.releaseForIdle();
    expect(rawClient.end).not.toHaveBeenCalled();

    await expect(release).resolves.toBeUndefined();
    await expect(publish).resolves.toBeUndefined();

    expect(landed.has("/remote/id-0-12.json")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an operation issued while the release was still QUEUED behind another transition is likewise not torn", async () => {
    // Both of the entry gate's readings are written from INSIDE the release's own
    // transition, so an operation issued while that release is still queued reads
    // neither and goes straight onto the session that is still live. It is on the
    // wire by the time the release enters, and the precondition is read there --
    // after the acquire -- which is what covers this class for free.
    const { client, connect, rawClient, state } =
      ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    // A dial parked on the queue, so the release below takes a real queue slot
    // behind it rather than entering in the same tick.
    let finishDial!: () => void;
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDial = () => resolve();
        }),
    );
    const dial = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const release = adapter.releaseForIdle();
    // Issued AFTER the release was requested, and reaching the transport in the
    // same tick: the gate deferred nothing, because neither of its readings is
    // written until that release enters.
    const removal = adapter.delete("/remote/out.json");
    expect(client.delete).toHaveBeenCalledOnce();

    finishDial();
    await dial;
    await expect(release).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("the release happens at the next boundary once that operation has settled", async () => {
    // The hold costs the mode one idle gap and no more: it is not a latch, just a
    // reading of the wire, so the boundary after the operation settles ends the
    // session exactly as an undisturbed one does.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("an idle boundary with nothing outstanding still releases as today, synchronously with the call", async () => {
    // The precondition buys the ordinary path nothing to pay: a cycle whose
    // operations have settled leaves the wire empty, and the boundary has still
    // driven the ssh2 Client's end() by the time releaseForIdle() returns to its
    // caller -- no await was introduced ahead of the transition body.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await expect(adapter.delete("/remote/out.json")).resolves.toBeUndefined();

    const released = adapter.releaseForIdle();
    // Read with no await between it and the call above.
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("a teardown with an operation outstanding does NOT wait for it to drain", async () => {
    // The precondition is the release's alone. A teardown that waited for the wire
    // to clear would park the close behind an operation whose own ceiling is the
    // exchange's, and would be waiting on the very operation the close ends.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.end()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledOnce();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("a recovery re-dial with an operation outstanding does NOT wait for it to drain", async () => {
    // A re-dial that held for the wire would park behind the very class of
    // operation that drove it: the concurrent send whose own loss is being
    // recovered from is exactly what would be outstanding.
    const { client, connect, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);
    const removal = adapter.delete("/remote/out.json");

    // The session drops under a second operation, which recovers through the
    // re-dial while the first is still on the wire.
    state.live = false;
    await expect(adapter.exists("/remote/in.json")).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("a rejecting operation balances the count as well as a resolving one", async () => {
    // A failure that left the count up would pin the session open for the rest of
    // the exchange: every later boundary would read an operation on a wire that had
    // been empty since. The boundary this one straddles is held, and the boundary
    // after it rejects is not.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    expect(rawClient.end).not.toHaveBeenCalled();

    operation.fail(new Error("the server refused the delete"));
    await expect(removal).rejects.toThrow("the server refused the delete");

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
  });

  test("a held boundary counts as held, not as declined or forced", async () => {
    // The declined count states a cause -- another session transition that did not
    // complete within the release's wait -- which is false of a hold, and the
    // end-of-run line it feeds would report an anomaly where a concurrent send
    // straddling a boundary is ordinary. Nor is a held boundary a closed one, so the
    // forced-release total stays where it is too. The hold has an end-of-run total
    // of its own, which is where these boundaries land instead.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);

    const removal = adapter.delete("/remote/out.json");
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.declinedReleaseCount).toBe(0);
    expect(adapter.forcedReleaseCount).toBe(0);
    // Nor a boundary the partner closed on request: a hold closed nothing at all.
    expect(adapter.releasedBoundaryCount).toBe(0);
    expect(adapter.heldBoundaryCount).toBe(2);
    expect(adapter.heldBoundaryStretchCount).toBe(1);
    // Accounted, never warned: the operator hears about the run's total at the end
    // and about no single occurrence.
    expect(adapterLog(adapter).warn).not.toHaveBeenCalled();

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("one unsettled operation across several boundaries counts each boundary and one stretch", async () => {
    // The case the total exists for: an operation with no bound of its own holds
    // every remaining boundary, so the mode's per-cycle session lifetime has lapsed
    // for the rest of the run. Five boundaries lost, one uninterrupted hold -- and
    // it is the stretch count that says the mode stopped rather than merely paying
    // for five straddling sends.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(client);
    const removal = adapter.delete("/remote/out.json");

    for (let boundary = 0; boundary < 5; boundary += 1)
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.heldBoundaryCount).toBe(5);
    expect(adapter.heldBoundaryStretchCount).toBe(1);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  test("operations settling between boundaries count one stretch each", async () => {
    // The ordinary case, which must not read like the one above: a send straddling
    // a boundary costs one idle gap and then lets the wire empty, so the next hold
    // is a fresh stretch. Three sends, three boundaries, three stretches -- the mode
    // is working and the counts say so.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const operation = pendingDelete(client);
      const removal = adapter.delete(`/remote/out-${cycle}.json`);
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
      operation.settle();
      await expect(removal).resolves.toBeUndefined();
    }

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(adapter.heldBoundaryCount).toBe(3);
    expect(adapter.heldBoundaryStretchCount).toBe(3);
  });

  test("both held counts stay at zero on a run that holds no boundary, in either mode", async () => {
    // The guard the end-of-run line rests on: a clean run of the mode prints
    // nothing, and the default held-session mode -- which runs no idle release at
    // all -- prints nothing either.
    const { client, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await expect(adapter.delete("/remote/out.json")).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).toHaveBeenCalledOnce();
    expect(adapter.heldBoundaryCount).toBe(0);
    expect(adapter.heldBoundaryStretchCount).toBe(0);

    const held = ephemeralClient(wrapperMethods());
    const persistent = new SSH2SFTPClientAdapter();
    captureAdapterLog(persistent);
    installClient(persistent, held.client);

    await persistent.connect({ host: "h", maxReconnectAttempts: 0 });
    const operation = pendingDelete(held.client);
    const removal = persistent.delete("/remote/out.json");
    // No release runs in the default mode, so the outstanding operation reaches no
    // boundary to hold.
    await expect(persistent.releaseForIdle()).resolves.toBeUndefined();

    expect(persistent.heldBoundaryCount).toBe(0);
    expect(persistent.heldBoundaryStretchCount).toBe(0);

    operation.settle();
    await expect(removal).resolves.toBeUndefined();
  });

  // Transitions holding or waiting on the session lock. Read only to place a
  // boundary: a recovery re-dial that has left this count is one whose session is
  // established and whose queue is free, which is the near edge of the window
  // between that re-dial and the re-issue it was for.
  const pendingSessionTransitions = (adapter: SSH2SFTPClientAdapter) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).pendingTransitions as number;

  test("an operation the adapter never settles holds every later boundary", async () => {
    // The stated limit of the hold, not a desired behavior. The reading is of
    // operations ISSUED and unsettled, and nothing on this side settles an
    // operation the server never answers -- core's whole-exchange budget races and
    // abandons rather than cancelling -- so the hold lasts as long as the operation
    // does. A put from a string source is the shape with no adapter-side deadline
    // at all (no flat bound, no idle window), so its hold has no end short of the
    // exchange's.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn(() => new Promise<string>(() => {}));

    void adapter.put("/local/out.bin", "/remote/out.bin");
    expect(outstandingOperations(adapter)).toBe(1);

    for (let boundary = 0; boundary < 3; boundary += 1)
      await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    expect(outstandingOperations(adapter)).toBe(1);
  });

  test("a trickling upload holds every later boundary too: its progress window is re-armed, never tripped", async () => {
    // The other shape carrying no bound the hold can rely on: an operation whose
    // deadline is a progress-reset window (the chunked put's idle window here, the
    // capped get's sink likewise). A server acknowledging a chunk at a time re-arms
    // that window instead of tripping it, so the upload stays unsettled and every
    // boundary it spans is held.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 50,
    });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // One chunk acknowledged every 10 ms -- well inside the window -- against a
    // payload of 64 chunks, so the transfer is still trickling at the boundaries
    // below and the put itself is never answered.
    let chunksAcknowledged = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).put = vi.fn((source: Readable) => {
      source.pipe(
        new Writable({
          write(_chunk, _encoding, done) {
            chunksAcknowledged += 1;
            setTimeout(done, 10).unref();
          },
        }),
      );
      return new Promise<string>(() => {});
    });

    // The transfer is left unfinished by design, so its window trips whenever
    // the trickle stops after this test; swallow that so it cannot show up as an
    // unhandled rejection.
    void adapter
      .put(Buffer.alloc(64 * SFTP_PUT_PROGRESS_CHUNK_BYTES), "/remote/out.bin")
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(chunksAcknowledged).toBeGreaterThan(4);

    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();
    await expect(adapter.releaseForIdle()).resolves.toBeUndefined();

    expect(rawClient.end).not.toHaveBeenCalled();
    expect(state.live).toBe(true);
    expect(outstandingOperations(adapter)).toBe(1);
  });

  test("an expired per-operation deadline settles the count while the request is still outstanding, and the next boundary closes over it", async () => {
    // The direction the count departs from the wire the other way. Every adapter
    // bound is a race that abandons rather than a cancellation, so an expired one
    // settles the operation on this side with the library request still outstanding
    // at the server. What the precondition holds a boundary for is an UNSETTLED
    // operation, which this one no longer is.
    const { client, rawClient, state } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({
      ephemeralSessions: true,
      stallDeadlineMs: 50,
    });
    captureAdapterLog(adapter);
    installClient(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    let libraryRequestSettled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).exists = vi.fn(() =>
      new Promise<boolean>(() => {}).finally(() => {
        libraryRequestSettled = true;
      }),
    );

    const probe = adapter.exists("/remote/in.json");
    expect(outstandingOperations(adapter)).toBe(1);
    await expect(probe).rejects.toBeInstanceOf(TransportOperationStalledError);
    expect(outstandingOperations(adapter)).toBe(0);
    expect(libraryRequestSettled).toBe(false);

    const released = adapter.releaseForIdle();
    expect(rawClient.end).toHaveBeenCalledOnce();
    await expect(released).resolves.toBeUndefined();
    expect(state.live).toBe(false);
  });

  test("a release whose ssh2 end() throws leaves the next drop counted and warned", async () => {
    // The release drove nothing: its end() raised before the transport was
    // touched, so the session it failed to close is still the server's to drop.
    // A boundary that classified itself as deliberate anyway would hand that
    // drop the release's exemption and the operator would never hear about it.
    const { client, connect, state, rawClient } =
      ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
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
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );
    expect(state.live).toBe(true);

    // The server drops the session the release could not close.
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a forced release that cannot clear the session leaves the next drop counted and warned", async () => {
    // The partner withheld its close, the release destroyed the transport itself,
    // and the session STILL did not clear -- so the release ends having released
    // nothing it can vouch for. The drop that follows is the server's, and is
    // counted and warned as one.
    vi.useFakeTimers();
    try {
      const { client, connect, state, sock } =
        withheldCloseClient(wrapperMethods());
      // A destroy that tears the socket down without the ssh2 Client 'close' that
      // clears the session: the assumption the release reads back and raises on.
      sock.destroy = vi.fn();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
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
      // The rejection handler is attached before the clock advances, so the
      // release's failure is never momentarily unhandled.
      const release = expect(adapter.releaseForIdle()).rejects.toThrow(
        "did not clear",
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await release;
      expect(state.live).toBe(true);

      // The server drops the session the release could not clear.
      state.live = false;
      await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(adapter.reconnectCount).toBe(1);
      expect(adapter.midExchangeReconnectCount).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped mid-exchange"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a dial that raises over the session it established drops the boundary", async () => {
    // The cycle-start dial establishes its session and then raises in its own
    // post-connect verification, so it never reaches the discharge at the end of
    // that dial -- and the mode reports the raise as a cycle to skip rather than a
    // failure, leaving the run over a LIVE session with the previous release's
    // boundary behind it. That boundary may not stand there: the session is the
    // server's to drop, and a drop it exempted would reach neither the reconnect
    // counters nor the operator.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
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
    await adapter.releaseForIdle();
    expect(releaseBoundaryStands(adapter)).toBe(true);

    // The call site the release is verified against is gone by the next dial, which
    // checks it after the handshake has established the session.
    delete (rawClient._sock as Record<string, unknown>).writableEnded;
    await expect(adapter.ensureConnected()).resolves.toBe(false);
    expect(state.live).toBe(true);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    // The release that follows drives nothing either: the same absent call site refuses
    // it before it reaches the transport, so it too ends nothing.
    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "which the installed SFTP library does not support",
    );
    expect(state.live).toBe(true);

    // The absent call site is not what is under test past this point: put it back so the
    // drop below has a re-dial to recover on.
    (rawClient._sock as Record<string, unknown>).writableEnded = false;
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("a release that ends nothing exempts no drop, whatever it entered with", async () => {
    // The rule is over the state rather than the transition: the boundary stands
    // only where no session does. A release entering with one already standing is
    // what that rule makes unreachable, so it is set here directly -- what this
    // pins is that a release which ended nothing cannot hand the reading on,
    // however it came to be standing.
    const { client, state, rawClient } = ephemeralClient(wrapperMethods());
    rawClient.end = vi.fn(() => {
      throw new Error("socket already destroyed");
    });
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).sessionBoundary = "deliberatelyReleased";

    await expect(adapter.releaseForIdle()).rejects.toThrow(
      "socket already destroyed",
    );
    expect(state.live).toBe(true);
    expect(boundarySaysReleaseTookTheSession(adapter)).toBe(false);

    // The server drops the session the release could not close.
    state.live = false;
    await expect(adapter.exists("/remote/out.json")).resolves.toBe(true);

    expect(adapter.reconnectCount).toBe(1);
    expect(adapter.midExchangeReconnectCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped mid-exchange"),
    );
  });

  test("teardown never runs the client down under a cycle-start dial", async () => {
    // The mirror of the recovery case above, on the dial the poll loop itself
    // starts. close() can reach end() while a cycle-start handshake is still
    // running on the one shared Ssh2SftpClient: ssh2-sftp-client's own end() would
    // short-circuit on the session that handshake has not restored yet, resolving
    // WITHOUT ending the ssh2 Client -- so close() would return while an SSH dial
    // still holds a ref'd socket.
    const wrapper = wrapperMethods();
    const state = { live: true };
    let dialReached!: () => void;
    const dialing = new Promise<void>((resolve) => {
      dialReached = resolve;
    });
    let dialsInFlight = 0;
    let dials = 0;
    const events: string[] = [];
    const connect = vi.fn().mockImplementation(async () => {
      dials += 1;
      if (dials === 1) {
        state.live = true;
        return;
      }
      dialsInFlight += 1;
      events.push("dial:start");
      try {
        dialReached();
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

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    // The previous cycle released; this cycle's dial is in flight.
    state.live = false;
    const ready = adapter.ensureConnected();
    await dialing;
    const closed = adapter.end();
    await Promise.all([ready, closed]);

    expect(events).not.toContainEqual(
      expect.stringMatching(/^teardown:.*dialsInFlight=[1-9]/),
    );
    expect(events).toEqual([
      "dial:start",
      "dial:end",
      "teardown:client.end (dialsInFlight=0)",
    ]);
  });
});
