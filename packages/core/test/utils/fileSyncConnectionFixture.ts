// The mock transport client and connection builders the file-sync suites
// share: a FileSyncConnection driven against an in-memory directory, and the
// readers that reach the connection state a test cannot see from outside.

import {
  FileSyncConnection,
  type FileTransportClient,
  type FileInfo,
} from "../../src/connection/fileSyncConnection";
import type { FileDropConnectionConfig } from "../../src/config/connection";

// The poll/ack/seq counters live on the connection's composed FileSyncMessageLoop;
// the white-box pokes that read or set them reach through it. conn.seq is a
// delegating getter/setter on the connection, so it is read and written directly;
// responsibleFiles/foreignFileSnapshot/abortController are connection-side.
export function messageLoopInternals(conn: FileSyncConnection): {
  pollerActive: boolean;
  lastSentFile?: string;
  recvSeq: number;
  lastAckedNNN: number;
} {
  return (
    conn as unknown as {
      messageLoop: {
        pollerActive: boolean;
        lastSentFile?: string;
        recvSeq: number;
        lastAckedNNN: number;
      };
    }
  ).messageLoop;
}

// Reduce a put() src to the on-disk bytes a real transport writes: a chunk-list
// is joined, a lone Buffer and a drained stream pass through. A string src is a
// local file PATH to a real transport (never an in-memory body), so it throws
// here as the real adapters do rather than silently dropping the body.
async function putSrcBytes(
  src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
): Promise<Buffer> {
  if (typeof src === "string")
    throw new Error("put expects a Buffer or chunk-list body, not a string");
  if (Buffer.isBuffer(src)) return src;
  if (Array.isArray(src)) return Buffer.concat(src);
  const chunks: Buffer[] = [];
  for await (const chunk of src)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// A mock-transport operation's behavior: "real" runs against the in-memory
// store, "throw" always rejects (models a transport that lacks the operation),
// "noop" resolves without touching the store (a silent no-op).
type MockBehavior = "real" | "throw" | "noop";

export interface MockClientOptions {
  // Share one store across two clients (the two-party single-directory model);
  // omitted, each client gets a fresh Map.
  files?: Map<string, Buffer>;
  // Default "real". "throw" models a no-delete transport whose delete() always
  // rejects; the ack-handshake barrier must complete rendezvous anyway.
  deleteBehavior?: MockBehavior;
  // Default "real" (a working EEXIST atomic create). "throw" models a lockless
  // transport that lacks atomic exclusive-create, forcing the ack-handshake
  // barrier instead of the lock/EEXIST fast-path.
  createExclusiveBehavior?: "real" | "throw";
  // Spy fired before delete's behavior runs (proves delete was/was not called).
  onDelete?: (path: string) => void;
  // Spy fired at the start of get() (proves an ack body was/was not read).
  onGet?: (path: string) => void;
}

export function makeMockClient(opts?: MockClientOptions): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
} {
  const files = opts?.files ?? new Map<string, Buffer>();
  const deleteBehavior = opts?.deleteBehavior ?? "real";
  const createExclusiveBehavior = opts?.createExclusiveBehavior ?? "real";
  // A throwing-delete transport pairs with a swallowing safeDelete.
  const safeDeleteBehavior = deleteBehavior === "real" ? "real" : "noop";

  const realDelete = (path: string): void => {
    files.delete(path);
  };
  const deleteFor =
    (behavior: MockBehavior) =>
    async (path: string): Promise<void> => {
      if (behavior === "throw")
        throw new Error("delete not supported on this transport");
      if (behavior === "real") realDelete(path);
    };

  const client: FileTransportClient = {
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      opts?.onGet?.(path);
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      files.set(dest, await putSrcBytes(src));
    },
    delete: async (path: string) => {
      opts?.onDelete?.(path);
      return deleteFor(deleteBehavior)(path);
    },
    safeDelete: deleteFor(safeDeleteBehavior),
    rename: async (from: string, to: string) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
    },
    createExclusive: async (path: string) => {
      if (createExclusiveBehavior === "throw")
        throw new Error("createExclusive not supported on this transport");
      if (files.has(path))
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      files.set(path, Buffer.alloc(0));
    },
    exists: async (path: string) => files.has(path),
  };

  return { client, files };
}

// Put a connection into the post-open state without running the handshake.
// Calls open() with a fake filedrop config so this.config is populated and
// the drain deadline in close() reads peerTimeoutMs from the config rather
// than falling back to DEFAULT_PEER_TIMEOUT_MS (1 hour).
export async function makeConnectedConn(
  client: FileTransportClient,
  opts?: Partial<{
    pollingFrequency: number;
    timeToLiveMs: number;
    peerTimeoutMs: number;
    joinerRecoveryMs: number;
  }>,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
    ...(opts?.joinerRecoveryMs !== undefined
      ? { joinerRecoveryMs: opts.joinerRecoveryMs }
      : {}),
  });
  // Pass peerTimeoutMs via a fake filedrop config so close()'s drain deadline
  // reads from this.config rather than falling back to DEFAULT_PEER_TIMEOUT_MS.
  const fakeConfig: FileDropConnectionConfig = {
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: opts?.peerTimeoutMs ?? 50 },
  };
  await conn.open(fakeConfig);
  return conn;
}

// Drives conn.start()'s poller until its first error, returning the
// collected errors so the caller makes its own assertions. settleMs, if
// given, is an extra wait before stopping, to let a wrong reschedule bump a
// counter. pollerActiveBeforeDriverStop, captured just before that stop,
// shows whether a terminal error already stopped the poller on its own.
// stopInHandler makes the handler call conn.stop() itself, for tests
// proving the handler halts the loop.
export async function driveUntilError(
  conn: FileSyncConnection,
  opts?: {
    settleMs?: number;
    timeoutMessage?: string;
    stopInHandler?: boolean;
  },
): Promise<{ errors: unknown[]; pollerActiveBeforeDriverStop: boolean }> {
  const errors: unknown[] = [];
  let pollerActiveBeforeDriverStop!: boolean;
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));
  conn.on("error", (err) => {
    errors.push(err);
    if (opts?.stopInHandler) conn.stop();
    notifyError();
  });
  conn.start();
  try {
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                opts?.timeoutMessage ?? "timed out waiting for poll error",
              ),
            ),
          2_000,
        ),
      ),
    ]);
    if (opts?.settleMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
  } finally {
    pollerActiveBeforeDriverStop = messageLoopInternals(conn).pollerActive;
    conn.stop();
  }
  return { errors, pollerActiveBeforeDriverStop };
}

export const LOCK_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
);

export function responsibleFilesOf(conn: FileSyncConnection): Set<string> {
  return (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
}

// Drives a poller until `signal` resolves or a safety timeout fires, then
// stops it. Shared race-free scaffolding for poll-loop tests in
// fileSyncConnection.test.ts, fileSyncSynchronize.test.ts, and
// fileSyncMessageLoop.test.ts.
export async function runPoller(
  conn: FileSyncConnection,
  signal: Promise<void>,
): Promise<void> {
  conn.start();
  await Promise.race([signal, new Promise<void>((r) => setTimeout(r, 2_000))]);
  conn.stop();
}

// Builds two FileSyncConnections sharing one in-memory directory, each
// already in the post-open connected state, for concurrent-rendezvous tests.
// The generous timeToLive means a stall would exceed the vitest timeout and
// fail the test, so a passing concurrent-mismatch test is itself proof the
// failure is at rendezvous, not the peer timeout.
//
// Determinism note: the mock client's list()/put() are synchronous
// (no await/delay), so the two parties interleave predictably and each sees
// the other's hello on its first poll; added mock latency would need fixing
// there, not in production.
export function makeRendezvousPair(
  idA: string,
  optsA: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  idB: string,
  optsB: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  setup?: {
    // Passed to makeMockClient so a pair can run against a throwing/no-op
    // transport or install a spy; the two conns share the resulting client and
    // its store, matching the single-directory two-party model.
    client?: MockClientOptions;
    timeToLiveMs?: number;
    pollingFrequency?: number;
  },
): {
  connA: FileSyncConnection;
  connB: FileSyncConnection;
  files: Map<string, Buffer>;
} {
  const { client, files } = makeMockClient(setup?.client);
  const make = (
    id: string,
    opts: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(client, {
      pollingFrequency: setup?.pollingFrequency ?? 5,
      timeToLive: new Date(Date.now() + (setup?.timeToLiveMs ?? 30_000)),
      verbose: -1,
      ...opts,
    });
    conn.id = id;
    conn.connected = true;
    conn.path = "/test";
    return conn;
  };
  return { connA: make(idA, optsA), connB: make(idB, optsB), files };
}

export function makeRetainConn(
  client: FileTransportClient,
  id: string,
  peerId: string,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/shared";
  conn.peerId = peerId;
  return conn;
}
