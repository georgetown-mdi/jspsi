// The client stand-ins and adapter readers the SFTP adapter's own test files
// share. Each stand-in models one thing ssh2-sftp-client and the ssh2 Client
// beneath it do at a session boundary; the readers reach private adapter state
// that has no public surface.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { SftpAdapterLedger } from "../../../src/connection/sftpAdapterLedger";

// A remote path naming the protocol's own in-flight write, temp-<uuidv4()>.tmp:
// the ONLY shape the record admits, so a case about the record must use a real
// one rather than a readable stand-in. randomUUID() emits the same canonical
// lowercase v4 form uuidv4() does in send()/writeAck().
export const protocolTempPath = (dir = "/remote"): string =>
  `${dir}/temp-${randomUUID()}.tmp`;

// The error ssh2-sftp-client's haveConnection() raises once its `sftp` property
// has been cleared -- what every high-level op below rejects with on a released
// session, so an op that reached the server without re-establishing first shows
// up as a counted, warned re-dial rather than passing silently.
// The exact error ssh2-sftp-client's haveConnection() raises on a cleared
// session: message "<name>: No SFTP connection available", code
// "ERR_NOT_CONNECTED" (node_modules/ssh2-sftp-client/src/utils.js +
// constants.js). Pinned here rather than matched by a loose string so a library
// bump that changes the identity is caught, per DEPENDENCY_PINS.md exact-pinning.
export const notConnected = (name: string) =>
  Object.assign(new Error(`${name}: No SFTP connection available`), {
    code: "ERR_NOT_CONNECTED",
  });

// The same stand-in plus the call sites the connection-per-poll idle release drives,
// which connect() verifies in that mode: the ssh2 Client's EventEmitter surface
// and its socket's destroy() and half-close flag. Also what a faithful stand-in
// for the pinned ssh2 Client looks like anywhere a recovery re-dial runs -- that
// EventEmitter surface is what its transport-lifecycle watch attaches to, and a
// Client without one puts the re-dial on its degraded branch.
export const releasableClient = () =>
  Object.assign(new EventEmitter(), {
    setNoDelay: () => {},
    _sock: { setKeepAlive: () => {}, writableEnded: false, destroy: () => {} },
    end: () => {},
  });

export function wrapperMethods(overrides: Record<string, unknown> = {}) {
  return {
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

// A wrapper stand-in that is a real EventEmitter, so connect()'s guarded
// fatal-'error' listener actually registers and a test can emit the malformed
// packet that kills the session. wrapperMethods()'s `on` is a plain mock, which
// registers nothing.
export const fatalErrorWrapper = () =>
  Object.assign(new EventEmitter(), {
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
  }) as unknown as EventEmitter & ReturnType<typeof wrapperMethods>;

export const captureAdapterLog = (adapter: SSH2SFTPClientAdapter) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).log = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    error: vi.fn(),
  };
};

// Replaces the adapter's logger with a warn-swallowing stub. The deadline /
// idle-window tests advance past SFTP_SLOW_OPERATION_WARNING_MS (30 s) on the
// way to the 60 s deadline, so the non-fatal slow-operation warning fires
// incidentally; this keeps it off the console. That warning's content is
// asserted by ssh2SftpAdapter.test.ts's slow-operation warning cases, so
// suppressing it here loses no coverage (this.log.warn is the only WARN sink).
export function stubAdapterLog(adapter: SSH2SFTPClientAdapter): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).log = { warn: vi.fn(), debug: vi.fn() };
}

export const adapterLog = (adapter: SSH2SFTPClientAdapter) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).log;

export const installClient = (
  adapter: SSH2SFTPClientAdapter,
  client: unknown,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).client = client;
};

// Replaces a client's exists() with one the test answers by hand, so the
// existence probe a rename re-issue fires can be left ON THE WIRE while
// something else happens to the session. `issued` resolves the moment the probe
// reaches the client, which is the only signal a caller has that the round trip
// it wants to interrupt has actually started.
export function pendingExists(client: object) {
  let answerProbe!: (present: boolean) => void;
  let markIssued!: () => void;
  const issued = new Promise<void>((resolve) => {
    markIssued = resolve;
  });
  const exists = vi.fn(() => {
    markIssued();
    return new Promise<boolean>((resolve) => {
      answerProbe = resolve;
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).exists = exists;
  return { exists, issued, answer: (present: boolean) => answerProbe(present) };
}

// The record of cleanup deletes the adapter is holding for re-issue. Private
// state with no public surface: what it holds decides whether a later
// re-establishment re-issues the delete, and its size is the bound the cap
// enforces, neither of which is observable from outside until the drain runs.
export const deferredCleanupRecord = (
  adapter: SSH2SFTPClientAdapter,
): ReadonlyMap<string, number> =>
  (
    adapter as unknown as {
      deferredCleanupDeletes: { recorded: ReadonlyMap<string, number> };
    }
  ).deferredCleanupDeletes.recorded;

// The recorded paths, in record order.
export const deferredCleanupPaths = (
  adapter: SSH2SFTPClientAdapter,
): string[] => [...deferredCleanupRecord(adapter).keys()];

// The re-issues each recorded path has left, in record order: the budget that
// decides whether a cleanup delete the server will never let succeed is retried
// again or given up on.
export const deferredCleanupBudgets = (
  adapter: SSH2SFTPClientAdapter,
): number[] => [...deferredCleanupRecord(adapter).values()];

// Whether the adapter's recorded session boundary stands as its own deliberate
// idle release -- the one reading that exempts a loss from the reconnect counters
// and the operator warning, as opposed to merely saying a release took the
// session. Private state with no public surface, read directly by a case --
// a release that released nothing, one during teardown, or one that
// closed over a transport a partner's drop had already ended -- that leaves no
// behavior, or none of its own, to read it through; each of those also asserts
// the behavior wherever one exists.
export const releaseBoundaryStands = (adapter: SSH2SFTPClientAdapter) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((adapter as any).sessionBoundary as string) === "deliberatelyReleased";

// The wider companion: whether the recorded boundary says a release took the
// session away at all, which both release readings do -- the reading the
// pre-establish gate and the deferred cleanup delete act on. A case whose point
// is that the release classified NOTHING asserts this one, so a reading that
// answered the session question would fail it rather than pass the narrower
// assertion above.
export const boundarySaysReleaseTookTheSession = (
  adapter: SSH2SFTPClientAdapter,
) =>
  ["deliberatelyReleased", "releasedOverEndedTransport"].includes(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).sessionBoundary as string,
  );

// Operations issued and not yet settled. Private state with no public surface,
// read both as an assertion of its own and to place a release at a chosen
// reading of it, since an idle transition queue is entered in the calling tick.
export const outstandingOperations = (adapter: SSH2SFTPClientAdapter) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((adapter as any).ledger as SftpAdapterLedger).outstandingOperations;

// A droppable client whose underlying ssh2 Client is a real EventEmitter: its
// end() clears the session (state.live=false) and emits 'close', modeling the
// ssh2-sftp-client global 'close' listener that clears this.sftp when the
// connection closes. connect() restores the session. This lets releaseForIdle's
// "drive the ssh2 Client's end() and await its 'close'" path run against a
// faithful stand-in without a live server. It has the whole high-level op
// surface (the raw-wrapper ops come from the caller's `wrapper`), so an op can
// be driven end to end across a boundary.
export function ephemeralClient(wrapper: ReturnType<typeof wrapperMethods>) {
  const state = { live: true };
  // The deletes the fixture actually performed.
  const deleted: string[] = [];
  const rawClient = new EventEmitter() as EventEmitter &
    Record<string, unknown>;
  // A live net.Socket reports Node's half-close flags and its post-destroy flag,
  // and has destroy(); the release's call sites are verified against the first two
  // at connect, and both forced closes read `destroyed` back where they drive it.
  const socket = {
    setKeepAlive: vi.fn(),
    writableEnded: false,
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
      state.live = false;
      rawClient.emit("close");
    }),
  });
  const connect = vi.fn().mockImplementation(async () => {
    state.live = true;
    // A dial gets a FRESH socket: whatever a previous cycle's teardown did to the
    // last one does not transfer to it, so a release reading the socket sees this
    // cycle's state rather than an earlier cycle's. Left alone when a test has
    // taken the socket, or the flag, away -- each of those is its own case.
    const dialed = rawClient._sock as
      { writableEnded?: boolean; destroyed?: boolean } | undefined;
    if (dialed?.writableEnded !== undefined) dialed.writableEnded = false;
    if (dialed?.destroyed !== undefined) dialed.destroyed = false;
  });
  const onLiveSession =
    <T>(name: string, value: T) =>
    async () => {
      if (!state.live) throw notConnected(name);
      return value;
    };
  const client = {
    get sftp() {
      return state.live ? wrapper : null;
    },
    // ssh2-sftp-client holds its session on a plain writable property (its own
    // listeners null it), so the stand-in is writable too: the release's
    // mechanism-unavailable fallback clears it directly.
    set sftp(value: ReturnType<typeof wrapperMethods> | null) {
      state.live = value !== null;
    },
    connect,
    client: rawClient,
    end: vi.fn().mockResolvedValue(true),
    realPath: vi.fn().mockResolvedValue("/"),
    get: vi.fn(onLiveSession("get", Buffer.from("payload"))),
    put: vi.fn(onLiveSession("put", "ok")),
    delete: vi.fn(async (path: string) => {
      if (!state.live) throw notConnected("delete");
      deleted.push(path);
    }),
    rename: vi.fn(onLiveSession("rename", undefined)),
    exists: vi.fn(onLiveSession("exists", true)),
  };
  return {
    client,
    connect,
    state,
    rawClient,
    socket,
    deleted,
  };
}

// A client whose ssh2 Client models the real close SEQUENCE rather than
// collapsing it: end() begins the teardown and the session keeps reading live
// until the 'close' that lands a macrotask later (ssh2-sftp-client clears
// `this.sftp` from that event, not from end()). An op issued between the two
// rejects the way a channel that is already going away does -- with the session
// property still set, the state that decides whether a rejection is a
// recoverable clean loss.
export function slowClosingClient(wrapper: ReturnType<typeof wrapperMethods>) {
  const state = { live: true, ending: false };
  const deleted: string[] = [];
  const rawClient = new EventEmitter() as EventEmitter &
    Record<string, unknown>;
  Object.assign(rawClient, {
    setNoDelay: vi.fn(),
    _sock: { setKeepAlive: vi.fn(), writableEnded: false, destroy: vi.fn() },
    end: vi.fn(() => {
      state.ending = true;
      setTimeout(() => {
        state.ending = false;
        state.live = false;
        rawClient.emit("close");
      }, 0);
    }),
  });
  const connect = vi.fn().mockImplementation(async () => {
    state.ending = false;
    state.live = true;
  });
  const client = {
    get sftp() {
      return state.live ? wrapper : null;
    },
    connect,
    client: rawClient,
    end: vi.fn().mockResolvedValue(true),
    realPath: vi.fn().mockResolvedValue("/"),
    exists: vi.fn(async () => {
      if (state.ending)
        throw new Error("Channel closed while the connection was ending");
      if (!state.live) throw notConnected("exists");
      return true;
    }),
    delete: vi.fn(async (path: string) => {
      if (state.ending)
        throw new Error("Channel closed while the connection was ending");
      if (!state.live) throw notConnected("delete");
      deleted.push(path);
    }),
  };
  return { client, connect, state, rawClient, deleted };
}

// A server that accepts the disconnect and then goes quiet. ssh2's Client.end()
// ends the socket and the Client emits 'close' only from the socket's own, so
// the connection sits in half-close: the transport is ended, no close ever
// arrives, and ssh2-sftp-client's session property stays set. Destroying the
// socket needs nothing from that server, and the 'close' it produces is what
// clears the session -- the sequence measured against a real ssh2 server.
export function withheldCloseClient(
  wrapper: ReturnType<typeof wrapperMethods>,
) {
  const built = ephemeralClient(wrapper);
  const { state, rawClient } = built;
  const sock = rawClient._sock as {
    writableEnded?: boolean;
    destroy?: () => void;
  };
  rawClient.end = vi.fn(() => {
    sock.writableEnded = true;
  });
  sock.destroy = vi.fn(() => {
    state.live = false;
    rawClient.emit("close");
  });
  return { ...built, sock };
}
