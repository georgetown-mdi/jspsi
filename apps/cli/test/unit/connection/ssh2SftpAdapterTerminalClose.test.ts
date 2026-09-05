// The bounded teardown against a partner that never closes the connection.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { installClient } from "./ssh2SftpAdapterFixtures";

// --- terminal close bound (a partner that never closes) ----------------------
//
// Closing an SFTP connection is a two-party act: this side disconnects and the
// server closes the connection. ssh2-sftp-client's end() settles only from the
// ssh2 Client's 'close', so a partner that accepts the disconnect and then goes
// quiet leaves it pending forever on a transport this side has already ended --
// and the half-open socket, a ref'd handle, keeps a completed run alive. The
// adapter bounds that wait and closes the connection from its own side. Common to
// BOTH session modes: nothing on the path is gated on connection-per-poll.

describe("terminal close against a partner that withholds its close", () => {
  const wrapper = () => ({
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
    on: vi.fn(),
  });

  interface TerminalCloseSocket {
    setKeepAlive: () => void;
    writableEnded: boolean;
    destroyed: boolean;
    destroy?: () => void;
  }

  // An ssh2-sftp-client stand-in modeling the pinned library against such a
  // partner: client.end() ends the transport and then stays PENDING, because the
  // ssh2 Client's 'close' it settles from never arrives. Destroying the socket
  // beneath it settles that same pending end() rather than rejecting it -- the
  // sequence measured against a real ssh2 server -- so the stand-in resolves it
  // from destroy(), the way the library does.
  function partnerThatNeverCloses(options: { closes?: boolean } = {}) {
    const state = { live: true };
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket: TerminalCloseSocket = {
      setKeepAlive: () => {},
      writableEnded: false,
      destroyed: false,
    };
    let settleEnd: (() => void) | undefined;
    socket.destroy = vi.fn(() => {
      socket.destroyed = true;
      state.live = false;
      rawClient.emit("close");
      settleEnd?.();
      settleEnd = undefined;
    });
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        socket.writableEnded = true;
      }),
    });
    const session = wrapper();
    const client = {
      get sftp() {
        return state.live ? session : null;
      },
      connect: vi.fn().mockResolvedValue(undefined),
      client: rawClient,
      end: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            socket.writableEnded = true;
            if (options.closes === true) {
              socket.destroyed = true;
              state.live = false;
              resolve();
              return;
            }
            settleEnd = resolve;
          }),
      ),
      realPath: vi.fn().mockResolvedValue("/"),
    };
    return { client, rawClient, socket };
  }

  function loggedAdapter(options: { ephemeralSessions?: boolean } = {}) {
    const adapter = new SSH2SFTPClientAdapter(options);
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

  // The adapter's own bounds (not exported; liveness safety checks, not tunables).
  const TERMINAL_CLOSE_BOUND_MS = 5_000;
  const FORCED_CLOSE_BOUND_MS = 1_000;

  test.each([
    { mode: "connection-per-poll", ephemeralSessions: true },
    { mode: "the default held session", ephemeralSessions: false },
  ])(
    "a teardown whose close never arrives settles within the bound in $mode",
    async ({ ephemeralSessions }) => {
      vi.useFakeTimers();
      try {
        const { client, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter({ ephemeralSessions });
        installClient(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

        let settled = false;
        const closing = adapter.end().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS - 1);
        // Still inside the bound: nothing has been forced and the close is the
        // partner's to complete.
        expect(settled).toBe(false);
        expect(socket.destroy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);
        await closing;

        expect(settled).toBe(true);
        // The socket is gone, so the process holds no half-open handle: this is
        // what the bound exists for, not merely returning the caller.
        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        // Informational, at default verbosity, once: teardown's close runs last,
        // so nothing here is treated as a failure.
        expect(log.info).toHaveBeenCalledTimes(1);
        const message = log.info.mock.calls[0][0] as string;
        expect(message).toContain("did not close the connection");
        expect(message).toContain("this side closed it");
        // end() runs from core's close() on EVERY teardown -- a failed run and a
        // bare connect/close included -- and the adapter has no notion of which,
        // so the line may claim nothing about the exchange or what it produced.
        expect(message).not.toMatch(/exchange|nothing was lost/i);
        expect(log.warn).not.toHaveBeenCalled();
        // Not the connection-per-poll release's boundary, so it is not counted as
        // one -- under either mode, and by neither of that boundary's two counts --
        // and no session was lost, so it is not a reconnection either.
        expect(adapter.forcedReleaseCount).toBe(0);
        expect(adapter.declinedReleaseCount).toBe(0);
        expect(adapter.reconnectCount).toBe(0);
        expect(adapter.midExchangeReconnectCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a teardown against a partner that closes settles on that close, with no added wait", async () => {
    // The healthy path must be untouched: end() resolves on the partner's own
    // close, the bound never expires, and nothing is destroyed or logged. Under
    // fake timers a resolution that needed the bound could not land at all, so
    // completing here IS the no-added-wait assertion.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses({ closes: true });
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      await adapter.end();

      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose end() rejects still closes the connection from this side", async () => {
    // ssh2-sftp-client's end() rejects from its temporary 'error' listener on a
    // non-ECONNRESET client error during teardown, having closed nothing: its
    // end/close listeners are gated off by endCalled, so the socket is left
    // exactly as a withheld close leaves it. A rejection is therefore not
    // "the partner closed" -- reading it that way skips the forced close and
    // hands the caller a live half-open socket, which is the process that never
    // exits.
    const { client, socket } = partnerThatNeverCloses();
    const { adapter, log } = loggedAdapter();
    installClient(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const failure = new Error("Unexpected close event");
    client.end = vi.fn(() => {
      socket.writableEnded = true;
      return Promise.reject(failure);
    });

    await expect(adapter.end()).rejects.toBe(failure);

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    // The operator hears what actually happened: nothing timed out here, so the
    // line names the failed close rather than a partner that ran out the bound.
    expect(log.info).toHaveBeenCalledTimes(1);
    const message = log.info.mock.calls[0][0] as string;
    expect(message).toContain("Unexpected close event");
    expect(message).toContain("this side closed");
    expect(message).not.toContain("teardown bound");
    // This line lands where a failed run's operator reads the verdict, so it may
    // not claim an outcome the adapter cannot know.
    expect(message).not.toMatch(/exchange|nothing was lost/i);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test.each([
    { seam: "client.once" },
    { seam: "client.removeListener" },
    { seam: "client._sock.writableEnded" },
  ])(
    "a teardown still closes the connection when only $seam has moved",
    async ({ seam }) => {
      // The terminal close drives client._sock.destroy() and reads
      // _sock.destroyed; it touches none of the call sites the connection-per-poll
      // release needs. Giving up on one of those would disable the forced destroy
      // over a member this path never calls -- and in the default mode connect()
      // checks nothing, so the first sign would be a completed run that never
      // exits.
      vi.useFakeTimers();
      try {
        const { client, rawClient, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter();
        installClient(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
        // Defined as an inert accessor rather than assigned: the stand-in's own
        // end() writes writableEnded back to true, so a plain assignment would
        // be undone before the close reads it and the case would pass vacuously.
        const relocate = (host: object, member: string): void => {
          Object.defineProperty(host, member, {
            get: () => undefined,
            set: () => {},
            configurable: true,
          });
        };
        if (seam === "client._sock.writableEnded")
          relocate(socket, "writableEnded");
        else relocate(rawClient, seam.slice("client.".length));

        const closing = adapter.end();
        await vi.advanceTimersByTimeAsync(
          TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
        );
        await expect(closing).resolves.toBeUndefined();

        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a teardown whose forced close has no mechanism takes its safe branch", async () => {
    // The call sites are verified at connect only in connection-per-poll mode, so the
    // default mode meets an ssh2 upgrade that relocated one here, at teardown.
    // Failing a dial over a teardown-only mechanism would ground every
    // default-mode exchange on an upgrade that costs it nothing, so the branch
    // warns and returns bounded instead.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      delete socket.destroy;
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      let settled = false;
      const closing = adapter.end().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS + 2);
      await closing;

      expect(settled).toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain(
        "not compatible with the installed SFTP library",
      );
      // The call site it drives is logged at debug, not put on the terminal.
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining("client._sock.destroy()"),
      );
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose destroyed socket does not close warns rather than throwing", async () => {
    // The one assumption connect() cannot check, because nothing at connect time
    // destroys the socket: it is read back where it is driven. Nothing here may
    // throw -- core logs an end() rejection at debug, so a throw would be
    // invisible and would accomplish nothing.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      socket.destroy = vi.fn();
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
      );
      await expect(closing).resolves.toBeUndefined();

      expect(socket.destroyed).toBe(false);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const message = log.warn.mock.calls[0][0] as string;
      expect(message).toContain("did not close after this side destroyed it");
      expect(message).toContain(
        "may not be compatible with the installed SFTP library",
      );
      // The connection was not closed on this branch, so the operator is not
      // told it was: the informational line follows the close it reports.
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown whose forced close throws warns rather than rejecting", async () => {
    // A throw out of net.Socket's destroy() must not become an end() rejection:
    // core logs one at debug, so it would tell the operator nothing while
    // suppressing the branch that does.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      socket.destroy = vi.fn(() => {
        throw new Error("socket already destroyed");
      });
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS + 2);
      await expect(closing).resolves.toBeUndefined();

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0] as string).toContain(
        "socket already destroyed",
      );
      // Nothing closed here either, so nothing claims it did.
      expect(log.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repeat close after a bounded teardown is a clean no-op", async () => {
    // The client was abandoned mid-end() and its socket destroyed under it, so a
    // second close must not re-enter it, re-destroy, or tell the operator twice.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
      );
      await closing;

      // No timer advance: a repeat that re-entered the client would sit out the
      // whole bound again rather than returning here.
      await expect(adapter.end()).resolves.toBeUndefined();

      expect(client.end).toHaveBeenCalledOnce();
      expect(socket.destroy).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    { when: "in the same tick", advanceMs: 0 },
    { when: "inside the bound", advanceMs: TERMINAL_CLOSE_BOUND_MS - 1 },
  ])(
    "a second close issued $when while the first is in flight forces the teardown once between them",
    async ({ advanceMs }) => {
      // Two closes can be in flight at once: withSessionRecovery issues a
      // re-entrant one when a re-dial lands inside a teardown an external close
      // has already latched. The forced close belongs to the CONNECTION, not to a
      // caller -- one client.end(), one destroy(), one line to the operator,
      // however many callers are waiting on it.
      vi.useFakeTimers();
      try {
        const { client, socket } = partnerThatNeverCloses();
        const { adapter, log } = loggedAdapter();
        installClient(adapter, client);
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

        const first = adapter.end();
        if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
        let secondSettled = false;
        const second = adapter.end().then(() => {
          secondSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        // The second caller waits for the close in flight rather than returning
        // over a connection still being closed.
        expect(secondSettled).toBe(false);
        expect(socket.destroy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(
          TERMINAL_CLOSE_BOUND_MS + FORCED_CLOSE_BOUND_MS + 2,
        );
        await Promise.all([first, second]);

        expect(secondSettled).toBe(true);
        expect(client.end).toHaveBeenCalledOnce();
        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(socket.destroyed).toBe(true);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a terminally closed adapter refuses to connect again", async () => {
    // The close is memoized for the CONNECTION and never cleared, so a second
    // session dialed on this adapter would answer a later close() from that
    // settled memo and never be ended at all -- a live session and a ref'd handle
    // left behind on a run that believes it closed. Every caller in the tree
    // builds a fresh adapter per connection, so the refusal is what keeps that
    // true rather than a note asking a future caller to.
    const { client, socket } = partnerThatNeverCloses({ closes: true });
    const { adapter } = loggedAdapter();
    installClient(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();
    expect(socket.destroyed).toBe(true);

    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
    ).rejects.toThrow("cannot be reopened");
    expect(client.connect).toHaveBeenCalledOnce();
  });

  test("a connect issued during an in-flight teardown parks, then refuses", async () => {
    // connect() takes the transition queue like every other transition, in both
    // session modes, so one issued while a teardown is still closing waits that
    // teardown out and refuses on the far side of it rather than refusing at once.
    // The alternative -- reading the teardown latch before the acquire -- would be
    // a second reading of it outside the lock, for a faster failure with the same
    // wording on a path nothing in the tree takes. A dial issued once the teardown
    // has settled does not park at all: the queue is drained by then.
    vi.useFakeTimers();
    try {
      const { client, socket } = partnerThatNeverCloses();
      const { adapter } = loggedAdapter();
      installClient(adapter, client);
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

      const closing = adapter.end();
      const reopen = adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      const refused = expect(reopen).rejects.toThrow("cannot be reopened");
      let reopenSettled = false;
      void reopen.catch(() => {
        reopenSettled = true;
      });

      await vi.advanceTimersByTimeAsync(TERMINAL_CLOSE_BOUND_MS - 1);
      expect(reopenSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS + 2);
      await Promise.all([closing, refused]);
      expect(socket.destroyed).toBe(true);
      // The parked dial refused rather than reaching the client.
      expect(client.connect).toHaveBeenCalledOnce();

      // No timer stands between this caller and its refusal: under fake timers a
      // refusal that needed one could not land at all.
      await expect(
        adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
      ).rejects.toThrow("cannot be reopened");
      expect(client.connect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a close that rejects is shared by a repeat rather than re-attempted", async () => {
    // The connection has one terminal close and one outcome. The rejection is only
    // ever visible over a connection this side has already closed -- the memo does
    // not settle until the forced close has run -- so re-driving the client has
    // nothing left to close, and core logs an end() rejection at debug either way.
    const { client, socket } = partnerThatNeverCloses({ closes: true });
    const { adapter } = loggedAdapter();
    installClient(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    const failure = new Error("Unexpected close event");
    client.end = vi.fn().mockRejectedValue(failure);

    await expect(adapter.end()).rejects.toBe(failure);
    expect(socket.destroyed).toBe(true);
    await expect(adapter.end()).rejects.toBe(failure);

    expect(client.end).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
