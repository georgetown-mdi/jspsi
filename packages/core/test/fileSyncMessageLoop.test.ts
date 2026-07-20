import { describe, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { default as EventEmitter } from "eventemitter3";

import {
  messageFilename,
  resolveUnexpectedFilesPolicy,
  isRecognizedLoopFile,
  FileSyncMessageLoop,
  type MessageLoopDeps,
  type MessageLoopOptions,
} from "../src/connection/fileSyncMessageLoop";
import type {
  FileInfo,
  FileTransportClient,
} from "../src/connection/fileSyncConnection";
import {
  serializeFileSyncMessage,
  MESSAGE_TYPE_OBJECT,
} from "../src/connection/fileSyncFraming";
import { ackMarkerName } from "../src/connection/fileSyncNames";
import { MAX_FRAME_SIZE_BYTES } from "../src/connection/frameSize";
import { cancellableDelay } from "../src/connection/fileSyncConstants";
import {
  UsageError,
  PeerAbortError,
  FrameSizeExceededError,
} from "../src/errors";
import { getLoggerForVerbosity } from "../src/utils/logger";

// Per-seam contract coverage for the pure message-loop classification helpers.
// Before the split these were only exercised behind FileSyncConnection's
// poll()/send(); these tests pin the filename form, the policy defaults, and the
// loop-file grammar branches directly.

describe("messageFilename", () => {
  test("no-timestamp form is <id>-<byteCount>.json", () => {
    expect(
      messageFilename({
        id: "alice",
        timestampInFilename: false,
        byteCount: 42,
        seq: 3,
        ts: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
    ).toBe("alice-42.json");
  });

  test("timestamped form is <id>-<ts>-<counter>-<byteCount>.json", () => {
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 100,
        seq: 5,
        ts: Date.UTC(2026, 0, 2, 3, 4, 5),
      }),
    ).toBe("bob-20260102T030405-005-100.json");
  });

  test("counter zero-pads to three digits and widens past 999", () => {
    const ts = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 7,
        seq: 7,
        ts,
      }),
    ).toBe("bob-20260102T030405-007-7.json");
    expect(
      messageFilename({
        id: "bob",
        timestampInFilename: true,
        byteCount: 7,
        seq: 1000,
        ts,
      }),
    ).toBe("bob-20260102T030405-1000-7.json");
  });
});

describe("resolveUnexpectedFilesPolicy", () => {
  test("an explicit policy always wins over the mode default", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        unexpectedFiles: "ignore",
        retainFiles: true,
        locklessRendezvous: true,
      }),
    ).toBe("ignore");
    expect(
      resolveUnexpectedFilesPolicy({
        unexpectedFiles: "error",
        retainFiles: true,
        locklessRendezvous: false,
      }),
    ).toBe("error");
  });

  test("retain mode defaults to warn", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: true,
        locklessRendezvous: false,
      }),
    ).toBe("warn");
  });

  test("lockless rendezvous defaults to warn", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: false,
        locklessRendezvous: true,
      }),
    ).toBe("warn");
  });

  test("plain delete mode defaults to error", () => {
    expect(
      resolveUnexpectedFilesPolicy({
        retainFiles: false,
        locklessRendezvous: false,
      }),
    ).toBe("error");
  });
});

describe("isRecognizedLoopFile", () => {
  const self = "alice";
  const peer = "bob";
  const recognized = (
    name: string,
    snapshot: ReadonlySet<string> = new Set(),
  ) => isRecognizedLoopFile(name, self, peer, snapshot);

  test("a foreign file snapshotted at entry is tolerated", () => {
    const snapshot = new Set(["leftover.txt"]);
    expect(recognized("leftover.txt", snapshot)).toBe(true);
    expect(recognized("leftover.txt")).toBe(false);
  });

  test("the protocol's own temp shape is recognized, a foreign temp is not", () => {
    expect(recognized(`temp-${uuidv4()}.tmp`)).toBe(true);
    expect(recognized("temp-notauuid.tmp")).toBe(false);
  });

  test("both expected abort markers are recognized, a foreign one is not", () => {
    expect(recognized("alice-abort.json")).toBe(true);
    expect(recognized("bob-abort.json")).toBe(true);
    expect(recognized("eve-abort.json")).toBe(false);
  });

  test("hellos match by exact name only", () => {
    expect(recognized("alice-hello.json")).toBe(true);
    expect(recognized("bob-hello.json")).toBe(true);
    expect(recognized("alice-x-hello.json")).toBe(false);
  });

  test("the lock matches by exact name in either arrival order", () => {
    expect(recognized("alice-bob-lock.json")).toBe(true);
    expect(recognized("bob-alice-lock.json")).toBe(true);
    expect(recognized("alice-x-lock.json")).toBe(false);
  });

  test("an own numeric terminal is recognized but a peer numeric terminal is not", () => {
    expect(recognized("alice-100.json")).toBe(true);
    expect(recognized("bob-100.json")).toBe(false);
  });

  test("an ack is recognized only when its inner target is a legal name", () => {
    expect(recognized("bob-alice-hello-ack.json")).toBe(true);
    expect(recognized("alice-bob-hello-ack.json")).toBe(true);
    expect(recognized("bob-alice-50-ack.json")).toBe(true);
    expect(recognized("alice-x-y-ack.json")).toBe(false);
  });

  test("a conflict copy of a protocol file is not recognized", () => {
    expect(recognized("alice-100 (conflicted copy).json")).toBe(false);
  });
});

// --- FileSyncMessageLoop coordinator ------------------------------------------
//
// Drives the stateful loop directly with stub deps and an in-memory
// FileTransportClient, asserting what the class-level poll()/send() tests reach
// only indirectly: that deps.emit is the sole emission channel (no local
// EventEmitter), the send/ack/recv counter commit points, the poller
// lifecycle/terminality, the inboundFrameCap clamp and read gate, the
// six-field session reset, and the abort-armed gate on the peer-marker read.

const DIR = "/loop";
const SELF = "self";
const PEER = "peer";

// The on-disk bytes of a peer JSON message in the binary envelope poll() reads.
const objectMessage = (payload: unknown, seq = 0): Buffer =>
  serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    seq,
    Buffer.from(JSON.stringify(payload)),
  );

interface MemClientOptions {
  getError?: (path: string) => Error | undefined;
  listError?: Error;
  renameError?: Error;
}

function memClient(
  files: Map<string, Buffer>,
  opts: MemClientOptions = {},
): FileTransportClient {
  const baseList = (dir: string): FileInfo[] => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return [...files.entries()]
      .filter(
        ([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
      )
      .map(([p, buf]) => ({
        name: p.slice(prefix.length),
        modifyTime: 0,
        size: buf.length,
      }));
  };
  return {
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      if (opts.listError) throw opts.listError;
      return baseList(dir);
    },
    get: async (path: string) => {
      const err = opts.getError?.(path);
      if (err) throw err;
      const data = files.get(path);
      if (!data) {
        const enoent = new Error(`${path}: not found`) as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      files.set(
        dest,
        Array.isArray(src)
          ? Buffer.concat(src as Uint8Array[])
          : (src as Buffer),
      );
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    safeDelete: async (path: string) => {
      files.delete(path);
    },
    rename: async (from: string, to: string) => {
      if (opts.renameError) throw opts.renameError;
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
    },
    createExclusive: async () => {},
    exists: async (path: string) => files.has(path),
  };
}

interface EmittedEvent {
  event: "data" | "error";
  arg: unknown;
  // The loop's own pollerActive at the moment of emit, so a terminal path can be
  // pinned to "cleared before the error emit".
  pollerActiveAtEmit: boolean;
}

// The loop's owned counters, reached through an `as unknown as` cast (they are
// private on the class; seq and lastSentFile are public).
type LoopInternals = {
  pollerActive: boolean;
  recvSeq: number;
  lastAckedNNN: number;
  consecutiveEnoentCount: number;
  inboundFrameCap: number | undefined;
  warnedUnexpectedFiles: Set<string>;
  poll(): Promise<void>;
};
const internals = (loop: FileSyncMessageLoop): LoopInternals =>
  loop as unknown as LoopInternals;

interface LoopFixture {
  loop: FileSyncMessageLoop;
  files: Map<string, Buffer>;
  emitted: EmittedEvent[];
  options: MessageLoopOptions;
  responsibleFiles: Set<string>;
  foreignFileSnapshot: Set<string>;
  state: {
    role: string;
    connected: boolean;
    abortArmed: boolean;
    verify: () => Promise<boolean>;
    verifyCalls: number;
    emitDataThrows: boolean;
  };
  // Drives one poll cycle: arms pollerActive (as start() would) then runs poll().
  pollOnce(): Promise<void>;
}

const baseOptions = (): MessageLoopOptions => ({
  retainFiles: false,
  locklessRendezvous: false,
  timestampInFilename: false,
  timeToLive: new Date(Date.now() + 60_000),
  // Deliberately huge so a success-path reschedule never fires during a test;
  // stop() clears the one pending timer.
  pollingFrequency: 3_600_000,
  unexpectedFiles: undefined,
});

function makeLoop(
  overrides: Partial<MessageLoopOptions> = {},
  clientOpts: MemClientOptions = {},
  files: Map<string, Buffer> = new Map(),
): LoopFixture {
  const options: MessageLoopOptions = { ...baseOptions(), ...overrides };
  const responsibleFiles = new Set<string>();
  const foreignFileSnapshot = new Set<string>();
  const controller = new AbortController();
  const client = memClient(files, clientOpts);
  const log = getLoggerForVerbosity("loop-test", -1);
  const emitted: EmittedEvent[] = [];
  const state = {
    role: "self-role",
    connected: true,
    abortArmed: false,
    verify: async () => false,
    verifyCalls: 0,
    emitDataThrows: false,
  };
  // The loop reference is needed inside emit to read pollerActive at emit time,
  // so it is filled in after construction.
  const holder: { loop?: FileSyncMessageLoop } = {};
  const deps: MessageLoopDeps = {
    responsibleFiles,
    foreignFileSnapshot,
    client: () => client,
    id: () => SELF,
    role: () => state.role,
    log: () => log,
    options: () => options,
    path: () => DIR,
    outbound: () => undefined,
    peerId: () => PEER,
    connected: () => state.connected,
    abortArmed: () => state.abortArmed,
    wait: (ms) => cancellableDelay(ms, controller.signal),
    emit: (event, arg) => {
      emitted.push({
        event,
        arg,
        pollerActiveAtEmit: (
          holder.loop as unknown as { pollerActive: boolean }
        ).pollerActive,
      });
      if (event === "data" && state.emitDataThrows)
        throw new Error("emit(data) failed");
      return true;
    },
    writeAck: async (dir, originalName) => {
      const name = ackMarkerName(SELF, originalName);
      files.set(`${dir}/${name}`, Buffer.alloc(0));
      return name;
    },
    verifyPeerAbortMarker: async () => {
      state.verifyCalls += 1;
      return state.verify();
    },
  };
  const loop = new FileSyncMessageLoop(deps);
  holder.loop = loop;
  return {
    loop,
    files,
    emitted,
    options,
    responsibleFiles,
    foreignFileSnapshot,
    state,
    pollOnce: async () => {
      internals(loop).pollerActive = true;
      await internals(loop).poll();
    },
  };
}

// A delete-mode peer message file name (<peer>-<byteCount>.json) plus its body,
// planted so a single poll selects and delivers it.
function plantDeleteMessage(
  files: Map<string, Buffer>,
  payload: unknown,
): void {
  const body = objectMessage(payload, 0);
  files.set(`${DIR}/${PEER}-${body.length}.json`, body);
}

// A retain-mode peer message file (<peer>-<ts>-000-<byteCount>.json), whose NNN
// segment must match recvSeq (0) for poll() to select it.
function plantRetainMessage(
  files: Map<string, Buffer>,
  payload: unknown,
): string {
  const body = objectMessage(payload, 0);
  const name = messageFilename({
    id: PEER,
    timestampInFilename: true,
    byteCount: body.length,
    seq: 0,
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  files.set(`${DIR}/${name}`, body);
  return name;
}

describe("FileSyncMessageLoop emit routing", () => {
  test("delivers messages only through deps.emit and holds no EventEmitter", async () => {
    const f = makeLoop();
    plantDeleteMessage(f.files, { hi: true });

    await f.pollOnce();
    f.loop.stop();

    expect(f.emitted).toEqual([
      { event: "data", arg: { hi: true }, pollerActiveAtEmit: true },
    ]);
    // The loop is not an EventEmitter and exposes no emit/on of its own, so the
    // connection's overridden emit stays the sole emission channel (and its
    // unhandled-error buffering cannot be bypassed).
    expect(f.loop).not.toBeInstanceOf(EventEmitter);
    expect(
      (f.loop as unknown as { emit?: unknown; on?: unknown }).emit,
    ).toBeUndefined();
    expect(
      (f.loop as unknown as { emit?: unknown; on?: unknown }).on,
    ).toBeUndefined();
  });
});

describe("FileSyncMessageLoop counter commit points", () => {
  test("seq advances only after the durable rename", async () => {
    const okFiles = new Map<string, Buffer>();
    const ok = makeLoop({}, {}, okFiles);
    await ok.loop.send({ a: 1 });
    expect(ok.loop.seq).toBe(1);
    expect(ok.loop.lastSentFile).toBe(
      `${SELF}-${objectMessage({ a: 1 }).length}.json`,
    );
    expect(ok.responsibleFiles.has(ok.loop.lastSentFile!)).toBe(true);

    // A rename that throws leaves seq unadvanced and lastSentFile unset, and the
    // temp is swept.
    const failFiles = new Map<string, Buffer>();
    const fail = makeLoop(
      {},
      { renameError: new Error("rename failed") },
      failFiles,
    );
    await expect(fail.loop.send({ a: 1 })).rejects.toThrow("rename failed");
    expect(fail.loop.seq).toBe(0);
    expect(fail.loop.lastSentFile).toBeUndefined();
    expect([...failFiles.keys()].some((p) => p.endsWith(".tmp"))).toBe(false);
  });

  test("retain: writeAck then lastAckedNNN then emit(data) then recvSeq++", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop(
      { retainFiles: true, timestampInFilename: true },
      {},
      files,
    );
    plantRetainMessage(files, { m: 1 });

    await f.pollOnce();
    f.loop.stop();

    // Happy path: the ack was written, lastAckedNNN and recvSeq advanced, and the
    // payload was delivered exactly once.
    const ackName = ackMarkerName(
      SELF,
      messageFilename({
        id: PEER,
        timestampInFilename: true,
        byteCount: objectMessage({ m: 1 }).length,
        seq: 0,
        ts: Date.UTC(2026, 0, 2, 3, 4, 5),
      }).slice(0, -".json".length),
    );
    expect(files.has(`${DIR}/${ackName}`)).toBe(true);
    expect(internals(f.loop).lastAckedNNN).toBe(0);
    expect(internals(f.loop).recvSeq).toBe(1);
    expect(f.emitted.map((e) => e.event)).toEqual(["data"]);
  });

  test("retain: an emit(data) failure holds recvSeq but keeps the ack (ack precedes emit, recvSeq follows)", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop(
      { retainFiles: true, timestampInFilename: true },
      {},
      files,
    );
    f.state.emitDataThrows = true;
    plantRetainMessage(files, { m: 1 });

    await f.pollOnce();
    f.loop.stop();

    // The ack (and lastAckedNNN) landed before emit, but recvSeq did not advance
    // because emit threw before recvSeq++ -- pinning the ordering.
    expect(internals(f.loop).lastAckedNNN).toBe(0);
    expect(internals(f.loop).recvSeq).toBe(0);
    expect(f.emitted.map((e) => e.event)).toEqual(["data", "error"]);
  });
});

describe("FileSyncMessageLoop poller lifecycle", () => {
  test("peer-abort path clears pollerActive synchronously before the error emit", async () => {
    const f = makeLoop();
    f.state.abortArmed = true;
    f.state.verify = async () => true;

    await f.pollOnce();

    expect(internals(f.loop).pollerActive).toBe(false);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].event).toBe("error");
    expect(f.emitted[0].arg).toBeInstanceOf(PeerAbortError);
    expect(f.emitted[0].pollerActiveAtEmit).toBe(false);
    expect(f.state.verifyCalls).toBe(1);
  });

  test("the peer-marker is read only when abortArmed()", async () => {
    const armed = makeLoop();
    armed.state.abortArmed = true;
    armed.state.verify = async () => false;
    await armed.pollOnce();
    armed.loop.stop();
    expect(armed.state.verifyCalls).toBe(1);

    const unarmed = makeLoop();
    unarmed.state.abortArmed = false;
    unarmed.state.verify = async () => true;
    await unarmed.pollOnce();
    unarmed.loop.stop();
    expect(unarmed.state.verifyCalls).toBe(0);
    expect(unarmed.emitted).toHaveLength(0);
  });

  test("the ENOENT threshold is terminal: pollerActive cleared before the error emit", async () => {
    const files = new Map<string, Buffer>();
    // list() surfaces the message but get() always ENOENTs (peer consumed it).
    const f = makeLoop(
      {},
      {
        getError: () => {
          const err = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          return err;
        },
      },
      files,
    );
    plantDeleteMessage(files, { m: 1 });
    // Two prior consecutive ENOENTs already counted, so this poll trips the
    // threshold in a single cycle (no reschedule leak).
    internals(f.loop).consecutiveEnoentCount = 2;

    await f.pollOnce();

    expect(internals(f.loop).pollerActive).toBe(false);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].event).toBe("error");
    expect(f.emitted[0].pollerActiveAtEmit).toBe(false);
  });

  test("a UsageError is terminal: two peer messages clear pollerActive before the error emit", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop({}, {}, files);
    const a = objectMessage({ m: 1 });
    const b = objectMessage({ m: 2 });
    files.set(`${DIR}/${PEER}-${a.length}.json`, a);
    // A distinct byte count so both names are present and both parse as messages.
    files.set(`${DIR}/${PEER}-${b.length + 1}.json`, b);

    await f.pollOnce();

    expect(internals(f.loop).pollerActive).toBe(false);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].event).toBe("error");
    expect(f.emitted[0].arg).toBeInstanceOf(UsageError);
    expect(f.emitted[0].pollerActiveAtEmit).toBe(false);
  });

  test("a transient failure reschedules: pollerActive stays set through the error emit", async () => {
    const f = makeLoop({}, { listError: new Error("transient list failure") });

    await f.pollOnce();

    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].event).toBe("error");
    // Not a UsageError, so the poller is NOT stopped -- the loop reschedules and
    // reprocesses on the next cycle.
    expect(f.emitted[0].arg).not.toBeInstanceOf(UsageError);
    expect(f.emitted[0].pollerActiveAtEmit).toBe(true);
    expect(internals(f.loop).pollerActive).toBe(true);
    // Clear the pending reschedule the finally armed.
    f.loop.stop();
  });
});

describe("FileSyncMessageLoop inboundFrameCap", () => {
  test("clamps to the static backstop and only ever tightens", () => {
    const f = makeLoop();
    f.loop.setInboundFrameCap(MAX_FRAME_SIZE_BYTES * 2);
    expect(internals(f.loop).inboundFrameCap).toBe(MAX_FRAME_SIZE_BYTES);
    f.loop.setInboundFrameCap(100);
    expect(internals(f.loop).inboundFrameCap).toBe(100);
    f.loop.setInboundFrameCap(undefined);
    expect(internals(f.loop).inboundFrameCap).toBeUndefined();
  });

  test("the read gate refuses a frame larger than the current cap", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop({}, {}, files);
    plantDeleteMessage(files, { m: 1 });
    // The envelope is well over 5 bytes (a 10-byte header alone), so the tightened
    // cap refuses it at the read gate before get() loads it.
    f.loop.setInboundFrameCap(5);

    await f.pollOnce();

    expect(internals(f.loop).pollerActive).toBe(false);
    expect(f.emitted).toHaveLength(1);
    expect(f.emitted[0].arg).toBeInstanceOf(FrameSizeExceededError);
  });
});

describe("FileSyncMessageLoop resetSessionState", () => {
  test("clears the six per-session fields and leaves poller/enoent counters", () => {
    const f = makeLoop();
    const i = internals(f.loop);
    f.loop.seq = 5;
    i.recvSeq = 3;
    i.lastAckedNNN = 2;
    f.loop.lastSentFile = "self-99.json";
    f.loop.setInboundFrameCap(50);
    i.warnedUnexpectedFiles.add("stray.json");
    i.consecutiveEnoentCount = 4;

    f.loop.resetSessionState();

    expect(f.loop.seq).toBe(0);
    expect(i.recvSeq).toBe(0);
    expect(i.lastAckedNNN).toBe(-1);
    expect(f.loop.lastSentFile).toBeUndefined();
    expect(i.inboundFrameCap).toBeUndefined();
    expect(i.warnedUnexpectedFiles.size).toBe(0);
    // consecutiveEnoentCount is NOT a per-session-reset field (start() clears it),
    // so resetSessionState leaves it untouched.
    expect(i.consecutiveEnoentCount).toBe(4);
  });
});
