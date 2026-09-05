// The ledger's per-generation loss accounting, read through the adapter.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";
import { UsageError } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

describe("SFTP adapter session accounting", () => {
  // A stand-in whose session lifecycle a case drives directly: the ssh2 Client's
  // EventEmitter surface the release and the recovery re-dial reach past the
  // public API for, and a socket whose half-close flags a case sets to stage the
  // three ways a session can end at an idle boundary.
  function accountingClient() {
    const state = { live: true, closesOnRequest: true };
    const wrapper = Object.assign(new EventEmitter(), {
      open: vi.fn(),
      close: vi.fn(),
      opendir: vi.fn(),
      readdir: vi.fn(),
    });
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const socket = {
      setKeepAlive: vi.fn(),
      writableEnded: false,
      readableEnded: false,
      destroyed: false,
      destroy: vi.fn(() => {
        socket.destroyed = true;
        state.live = false;
        rawClient.emit("close");
      }),
    };
    Object.assign(rawClient, {
      setNoDelay: vi.fn(),
      _sock: socket,
      end: vi.fn(() => {
        if (!state.closesOnRequest) {
          socket.writableEnded = true;
          return;
        }
        state.live = false;
        rawClient.emit("close");
      }),
    });
    let failInFlight: ((error: unknown) => void) | undefined;
    const connect = vi.fn().mockImplementation(async () => {
      // ssh2 mints a fresh socket per dial, so no half of it is ended.
      socket.writableEnded = false;
      socket.readableEnded = false;
      socket.destroyed = false;
      state.live = true;
    });
    const notConnected = () =>
      Object.assign(new Error("exists: No SFTP connection available"), {
        code: "ERR_NOT_CONNECTED",
      });
    const client = {
      get sftp() {
        return state.live ? wrapper : null;
      },
      connect,
      client: rawClient,
      end: vi.fn().mockResolvedValue(true),
      realPath: vi.fn().mockResolvedValue("/"),
      exists: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            if (!state.live) {
              reject(notConnected());
              return;
            }
            const answer = setTimeout(() => resolve(true), 0);
            failInFlight = (error: unknown) => {
              clearTimeout(answer);
              reject(error);
            };
          }),
      ),
    };
    // The partner drops the session, tearing whatever is on the wire with it.
    const dropFromServer = () => {
      state.live = false;
      failInFlight?.(notConnected());
      failInFlight = undefined;
    };
    return { client, connect, state, socket, wrapper, dropFromServer };
  }

  function install(adapter: SSH2SFTPClientAdapter, client: object): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (adapter as any).log = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      error: vi.fn(),
    };
    (adapter as any).client = client;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // The scenario's guard is the per-cause assertion each step makes below:
  // WHICH cause was charged, and that its total moved by exactly one. The
  // balance sum(losses) === generationsEnded is not asserted --
  // it is an arithmetic identity of the ledger (losses rise only where `live`
  // clears, and the ended count is derived from `live`), so it holds whatever
  // the adapter does and a missed or mis-attributed charge cannot move it.
  // What holds INV-L1 at runtime is structural instead: the dial charges any
  // pending end before advancing, and the ledger raises if one slips through.
  function lossesAfter(
    adapter: SSH2SFTPClientAdapter,
  ): Readonly<Record<string, number>> {
    return adapter.sessionAccounting.losses;
  }

  test("every generation a driven scenario ends records exactly one cause", async () => {
    vi.useFakeTimers();
    try {
      const { client, connect, state, socket, wrapper, dropFromServer } =
        accountingClient();
      const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
      install(adapter, client);

      await adapter.connect({ host: "h", maxReconnectAttempts: 4 });
      expect(lossesAfter(adapter)).toEqual({
        partner: 0,
        deliberate: 0,
        teardown: 0,
        fatal: 0,
      });

      // The ordinary release: this side drove the close and the partner answered.
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).deliberate).toBe(1);

      // A second boundary over the same already-ended generation adds nothing.
      await adapter.releaseForIdle();
      expect(adapter.sessionAccounting.losses.deliberate).toBe(1);

      // The peer's FIN consumed before the boundary: the session was the peer's to
      // take, and the release runs its course over one it did not end.
      await adapter.ensureConnected();
      socket.readableEnded = true;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(1);

      // The session already cleared when the boundary fell.
      await adapter.ensureConnected();
      state.live = false;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(2);

      // The partner's disconnect answered by ssh2 ending its own half, with
      // nothing on the wire: the release takes the session, the partner took what
      // the session was running on.
      await adapter.ensureConnected();
      socket.writableEnded = true;
      await adapter.releaseForIdle();
      expect(lossesAfter(adapter).partner).toBe(3);

      // A drop that tore an operation, recovered by the arm's own re-dial.
      await adapter.ensureConnected();
      const torn = adapter.exists("/remote/out.json");
      dropFromServer();
      // The re-issue's own round trip answers a tick later, which under this
      // case's fake clock has to be advanced to.
      await vi.advanceTimersByTimeAsync(10);
      await expect(torn).resolves.toBe(true);
      expect(lossesAfter(adapter).partner).toBe(4);

      // A partner that never answers the close, so this side forces it: a boundary
      // this side ended all the same.
      state.closesOnRequest = false;
      const forced = adapter.releaseForIdle();
      await vi.advanceTimersByTimeAsync(7_000);
      await forced;
      expect(adapter.forcedReleaseCount).toBe(1);
      expect(lossesAfter(adapter).deliberate).toBe(2);

      // A fatal SFTP protocol error kills the wrapper: the generation ends with a
      // cause of its own, and the teardown behind it records nothing over it.
      state.closesOnRequest = true;
      await adapter.ensureConnected();
      wrapper.emit("error", new Error("malformed SFTP packet"));
      expect(lossesAfter(adapter).fatal).toBe(1);

      await adapter.end();
      const losses = lossesAfter(adapter);
      expect(losses.teardown).toBe(0);

      // The boundary partition is total: every invocation of the release recorded
      // exactly one outcome.
      const releaseInvocations = 6;
      const boundaries = adapter.sessionAccounting.boundaries;
      expect(
        Object.values(boundaries).reduce((total, count) => total + count, 0),
      ).toBe(releaseInvocations);
      // And the counters an operator reads are those losses projected, never a
      // tally of their own.
      expect(adapter.midExchangeReconnectCount).toBe(losses.partner);
      expect(adapter.reconnectCount).toBe(losses.partner);
      expect(connect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a teardown of a live session records the teardown that ended it", async () => {
    const { client } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.end();

    const accounting = adapter.sessionAccounting;
    expect(accounting.losses).toEqual({
      partner: 0,
      deliberate: 0,
      teardown: 1,
      fatal: 0,
    });
    expect(accounting.generationsEnded).toBe(1);
    // Teardown mechanics, so nothing an operator would treat as a drop.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("a repeat connect() over a live session charges the replaced generation as deliberate", async () => {
    const { client } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    const accounting = adapter.sessionAccounting;
    expect(accounting.losses).toEqual({
      partner: 0,
      deliberate: 1,
      teardown: 0,
      fatal: 0,
    });
    expect(accounting.generationsEnded).toBe(1);
    // Replacing a session this side still held is this side's doing, so nothing
    // an operator would treat as a drop.
    expect(adapter.reconnectCount).toBe(0);
    expect(adapter.midExchangeReconnectCount).toBe(0);
  });

  test("a drop the exhausted budget refuses is charged like every other", async () => {
    // The budget bounds sessions LOST rather than re-dials made, so the drop it
    // refuses is recorded exactly as the ones it allowed: the generation ended,
    // and INV-L1 admits no generation that ends uncharged.
    const { client, connect, dropFromServer } = accountingClient();
    const adapter = new SSH2SFTPClientAdapter();
    install(adapter, client);

    await adapter.connect({ host: "h", maxReconnectAttempts: 1 });

    const first = adapter.exists("/remote/out.json");
    dropFromServer();
    await expect(first).resolves.toBe(true);
    expect(adapter.midExchangeReconnectCount).toBe(1);

    const refused = adapter.exists("/remote/out.json");
    dropFromServer();
    await expect(refused).rejects.toBeInstanceOf(UsageError);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(adapter.midExchangeReconnectCount).toBe(2);
    expect(lossesAfter(adapter).partner).toBe(2);

    await adapter.end();
    // The refused drop already took the session, so the teardown ends nothing.
    expect(lossesAfter(adapter)).toEqual({
      partner: 2,
      deliberate: 0,
      teardown: 0,
      fatal: 0,
    });
  });
});
