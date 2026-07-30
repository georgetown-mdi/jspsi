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
  TransportPublishIndeterminateError,
} from "../src/errors";
import { getLoggerForVerbosity } from "../src/utils/logger";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../src/utils/sanitizeForDisplay";

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
// seven-field session reset, and the abort-armed gate on the peer-marker read.

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
  indeterminatePublish:
    { seq: number; error: TransportPublishIndeterminateError } | undefined;
  inboundFrameCap: number | undefined;
  warnedUnexpectedFiles: Set<string>;
  poll(): Promise<void>;
};
const internals = (loop: FileSyncMessageLoop): LoopInternals =>
  loop as unknown as LoopInternals;

interface LoopFixture {
  loop: FileSyncMessageLoop;
  // The transport the loop was built on, so a case can replace one method for a
  // per-call behavior the shared MemClientOptions do not express.
  client: FileTransportClient;
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
    client,
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

// The one recovery send() prescribes for a publish the transport could not
// settle. Spelled out here rather than imported so an edit to the module constant
// has to be made deliberately in both places; the two messages that carry it are
// asserted against this single literal, so they cannot silently diverge.
const REMEDY =
  "Re-run the exchange in a clean directory; both parties must start the new " +
  "exchange fresh.";

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

  test("a publish the transport could not settle spends its seq slot", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop({}, {}, files);
    const realRename = f.client.rename.bind(f.client);
    let renames = 0;
    f.client.rename = async (from: string, to: string) => {
      renames += 1;
      if (renames > 1) return realRename(from, to);
      // The publish landed durably and the peer consumed it before the transport
      // could confirm it; from the transport's side that is indistinguishable
      // from a publish that never landed at all.
      await realRename(from, to);
      files.delete(to);
      // Caller-neutral, as the transport raises it: it names a publish, prescribes
      // no step, and carries no tag.
      throw new TransportPublishIndeterminateError(
        `the publish may or may not have reached the partner: it was cut off ` +
          `mid-operation and could not be confirmed afterwards. ` +
          `Destination: ${to}`,
        { cause: new Error("_rename: No such file or directory") },
      );
    };

    const rejected = await f.loop.send({ a: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(rejected).toBeInstanceOf(TransportPublishIndeterminateError);
    // The mechanical state after a rejected send is unchanged: the counter did
    // not advance, nothing was recorded as sent, and the temp was swept.
    expect(f.loop.seq).toBe(0);
    expect(f.loop.lastSentFile).toBeUndefined();
    expect([...f.responsibleFiles]).toEqual([]);
    expect([...files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);

    // What the caller is told, read where the operator reads it. send() is the one
    // publish reaching this class whose recovery is established, so it restates the
    // transport's neutral rejection as one that names the MESSAGE and carries that
    // recovery -- and tags it, which is what makes the length load-bearing: the tag
    // suppresses the CLI's generic "retry without re-inviting" advisory, so this
    // remedy is the only next step printed and has to end inside the renderer's
    // per-link cap.
    expect(
      (rejected as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBe(true);
    const publishRender = sanitizeErrorForDisplay(rejected);
    const [publishLink, ...publishCauseLinks] =
      publishRender.split("\ncaused by: ");
    expect(publishLink).toContain(
      "the message may or may not have reached the partner",
    );
    expect(publishLink).toContain(REMEDY);
    expect(publishLink).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // The transport's own rejection stays as the cause, so the destination and the
    // status it names render on their own lines under their own caps.
    expect(publishCauseLinks.join("\n")).toContain(
      `Destination: ${DIR}/${SELF}-${objectMessage({ a: 1 }).length}.json`,
    );
    expect(publishCauseLinks.join("\n")).toContain(
      "_rename: No such file or directory",
    );

    // What the counter's position does NOT license is reusing the slot: the peer
    // may already have consumed a message under that seq and delivered it, so a
    // second message written under it would be read as a second message rather
    // than as the retry it is. The refusal is at send() entry, before any write.
    const refused = await f.loop.send({ a: 2 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(UsageError);
    // The refusal prescribes a clean-directory restart, so it is tagged to
    // suppress the CLI's generic "retry without re-inviting" advisory: the two
    // would otherwise print together and contradict each other.
    expect(
      (refused as { psilinkRecoveryHintEmitted?: unknown })
        .psilinkRecoveryHintEmitted,
    ).toBe(true);
    // Asserted where the operator reads it, not on the raw .message: the tag
    // above is what makes this the only next step printed, and the renderer caps
    // each link of the cause chain, so a refusal whose remedy falls past that cap
    // leaves the operator no next step at all. The refusal's own link must
    // therefore carry the whole remedy and end inside the cap.
    const rendered = sanitizeErrorForDisplay(refused);
    const [refusalLink, ...causeLinks] = rendered.split("\ncaused by: ");
    expect(refusalLink).toContain("cannot send: sequence number 0 was spent");
    // The SAME remedy the publish's own rejection above gave: one condition, one
    // recovery, so an operator who reads both is not told two different things.
    expect(refusalLink).toContain(REMEDY);
    expect(refusalLink).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // The publish itself is identified by the transport's own error, which the
    // refusal hangs off `cause` so it renders under its own cap.
    expect(causeLinks.join("\n")).toContain(
      `Destination: ${DIR}/${SELF}-${objectMessage({ a: 1 }).length}.json`,
    );
    expect(causeLinks.join("\n")).toContain(
      "_rename: No such file or directory",
    );
    expect(renames).toBe(1);
    expect([...files.keys()]).toEqual([]);

    // Per-session state, not per-connection: a fresh session starts clean.
    f.loop.resetSessionState();
    await expect(f.loop.send({ a: 3 })).resolves.toBeUndefined();
    expect(f.loop.seq).toBe(1);
  });

  test("an ordinary rename failure leaves the seq slot reusable", async () => {
    const files = new Map<string, Buffer>();
    const f = makeLoop({}, {}, files);
    const realRename = f.client.rename.bind(f.client);
    let renames = 0;
    f.client.rename = async (from: string, to: string) => {
      renames += 1;
      if (renames > 1) return realRename(from, to);
      throw new Error("rename failed");
    };

    await expect(f.loop.send({ a: 1 })).rejects.toThrow("rename failed");
    // A determinate failure publishes nothing, so the same seq is written again
    // and the send completes -- the refusal above is scoped to the outcome the
    // transport could not settle, not to any failed send.
    await expect(f.loop.send({ a: 1 })).resolves.toBeUndefined();
    expect(f.loop.seq).toBe(1);
    expect(f.loop.lastSentFile).toBe(
      `${SELF}-${objectMessage({ a: 1 }).length}.json`,
    );
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
  test("clears the seven per-session fields and leaves poller/enoent counters", () => {
    const f = makeLoop();
    const i = internals(f.loop);
    f.loop.seq = 5;
    i.recvSeq = 3;
    i.lastAckedNNN = 2;
    f.loop.lastSentFile = "self-99.json";
    i.indeterminatePublish = {
      seq: 4,
      error: new TransportPublishIndeterminateError("publish torn", {
        cause: new Error("_rename: No such file or directory"),
      }),
    };
    f.loop.setInboundFrameCap(50);
    i.warnedUnexpectedFiles.add("stray.json");
    i.consecutiveEnoentCount = 4;

    f.loop.resetSessionState();

    expect(f.loop.seq).toBe(0);
    expect(i.recvSeq).toBe(0);
    expect(i.lastAckedNNN).toBe(-1);
    expect(f.loop.lastSentFile).toBeUndefined();
    expect(i.indeterminatePublish).toBeUndefined();
    expect(i.inboundFrameCap).toBeUndefined();
    expect(i.warnedUnexpectedFiles.size).toBe(0);
    // consecutiveEnoentCount is NOT a per-session-reset field (start() clears it),
    // so resetSessionState leaves it untouched.
    expect(i.consecutiveEnoentCount).toBe(4);
  });
});

// --- connection-per-poll session boundaries ----------------------------------
//
// In connection-per-poll mode the loop releases the transport session at the
// idle boundary of every cycle and dials a fresh one at the next cycle's start.
// The directory is server-side, so the boundary destroys nothing durable: what
// these pin is that the loop carries its own state across it -- the sequence
// shadow, the entry foreign-file snapshot, and the responsible-file set -- and
// that the only thing that clears any of them is resetSessionState(), which the
// boundary never calls.

// Records every transport op and attaches the two optional cycle-boundary
// methods, so a test can see where the boundary falls relative to the loop's own
// ops.
function installConnectionPerPoll(
  client: FileTransportClient,
  trace: string[],
): void {
  const ops = [
    "list",
    "get",
    "put",
    "delete",
    "safeDelete",
    "rename",
    "createExclusive",
    "exists",
  ] as const;
  const methods = client as unknown as Record<
    (typeof ops)[number],
    (...args: never[]) => Promise<unknown>
  >;
  for (const op of ops) {
    const inner = methods[op].bind(client);
    methods[op] = async (...args: never[]) => {
      trace.push(op);
      return inner(...args);
    };
  }
  client.ensureConnected = async () => {
    trace.push("dial");
    return true;
  };
  client.releaseForIdle = async () => {
    trace.push("release");
  };
}

const RETAIN_OPTIONS: Partial<MessageLoopOptions> = {
  retainFiles: true,
  timestampInFilename: true,
  locklessRendezvous: true,
};

// Plants the peer's retain-mode message for a given NNN, which retain never
// deletes: the directory accumulates the whole transcript and every poll
// re-lists it.
function plantRetainMessageAt(
  files: Map<string, Buffer>,
  nnn: number,
  payload: unknown,
): string {
  const body = objectMessage(payload, nnn);
  const name = messageFilename({
    id: PEER,
    timestampInFilename: true,
    byteCount: body.length,
    seq: nnn,
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  files.set(`${DIR}/${name}`, body);
  return name;
}

describe("FileSyncMessageLoop across connection-per-poll session boundaries", () => {
  // One poll cycle plus the release and reschedule its finally arms, with the
  // pending timer cleared so the next cycle starts from a quiet loop.
  const runCycle = async (f: LoopFixture): Promise<void> => {
    await f.pollOnce();
    f.loop.stop();
  };

  test("recvSeq stays aligned with the on-disk retain sequence across a session drop and re-dial", async () => {
    const files = new Map<string, Buffer>();
    const trace: string[] = [];
    const f = makeLoop(RETAIN_OPTIONS, {}, files);
    installConnectionPerPoll(f.client, trace);
    const planted = [0, 1, 2].map((nnn) =>
      plantRetainMessageAt(files, nnn, { n: nnn }),
    );

    for (let cycle = 0; cycle < 3; cycle++) {
      await runCycle(f);
      expect(internals(f.loop).recvSeq).toBe(cycle + 1);
      expect(internals(f.loop).lastAckedNNN).toBe(cycle);
    }

    expect(f.emitted.map((e) => e.arg)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    // Retain never deletes, so the on-disk sequence stays authoritative: each
    // re-dialed session re-lists the same transcript the released one saw, and
    // the shadow selects the next NNN from it rather than from anything the
    // session held.
    for (const name of planted) expect(files.has(`${DIR}/${name}`)).toBe(true);
    for (const name of planted)
      expect(
        files.has(
          `${DIR}/${ackMarkerName(SELF, name.slice(0, -".json".length))}`,
        ),
      ).toBe(true);
    // Every cycle ran inside its own dial/release bracket.
    expect(trace.filter((entry) => entry === "dial")).toHaveLength(3);
    expect(trace.filter((entry) => entry === "release")).toHaveLength(3);
    expect(trace[0]).toBe("dial");
    expect(trace[trace.length - 1]).toBe("release");
  });

  test("a mid-loop reconnect does not reset the sequence shadow", async () => {
    const files = new Map<string, Buffer>();
    const trace: string[] = [];
    const f = makeLoop(RETAIN_OPTIONS, {}, files);
    installConnectionPerPoll(f.client, trace);
    // The claim that a cycle boundary never resets the session, as a check: the
    // production callers of resetSessionState are the rendezvous recovery sites
    // and close(), none of which a poll cycle reaches.
    let resets = 0;
    const innerReset = f.loop.resetSessionState.bind(f.loop);
    f.loop.resetSessionState = () => {
      resets += 1;
      innerReset();
    };

    plantRetainMessageAt(files, 0, { n: 0 });
    await runCycle(f);
    expect(internals(f.loop).recvSeq).toBe(1);

    // Three further cycles with nothing to consume, each behind its own release
    // and re-dial.
    for (let cycle = 0; cycle < 3; cycle++) await runCycle(f);

    expect(internals(f.loop).recvSeq).toBe(1);
    expect(internals(f.loop).lastAckedNNN).toBe(0);
    expect(f.loop.seq).toBe(0);
    expect(resets).toBe(0);
    expect(trace.filter((entry) => entry === "dial")).toHaveLength(4);
    expect(trace.filter((entry) => entry === "release")).toHaveLength(4);
    expect(f.emitted.map((e) => e.arg)).toEqual([{ n: 0 }]);

    // The reset a cycle boundary never performs is what actually clears the
    // shadow, so the counters above were not simply inert.
    f.loop.resetSessionState();
    expect(internals(f.loop).recvSeq).toBe(0);
    expect(internals(f.loop).lastAckedNNN).toBe(-1);
  });

  test("retain-mode foreign and responsible-file bookkeeping is unchanged across cycles", async () => {
    const files = new Map<string, Buffer>();
    const trace: string[] = [];
    const f = makeLoop(
      { ...RETAIN_OPTIONS, unexpectedFiles: "error" },
      {},
      files,
    );
    installConnectionPerPoll(f.client, trace);
    // A foreign file the rendezvous entry scan snapshotted before the loop
    // started.
    files.set(`${DIR}/at-entry.txt`, Buffer.from("x"));
    f.foreignFileSnapshot.add("at-entry.txt");
    plantRetainMessageAt(files, 0, { n: 0 });
    plantRetainMessageAt(files, 1, { n: 1 });

    for (let cycle = 0; cycle < 4; cycle++) await runCycle(f);

    // Four release/re-dial boundaries introduced no foreign-file false
    // positive: the entry snapshot still classifies the same name as tolerated
    // under the strictest policy.
    expect(f.emitted.filter((e) => e.event === "error")).toEqual([]);
    expect(f.emitted.map((e) => e.arg)).toEqual([{ n: 0 }, { n: 1 }]);
    // Retain tracks nothing for cleanup, boundary or not.
    expect([...f.responsibleFiles]).toEqual([]);
    expect([...f.foreignFileSnapshot]).toEqual(["at-entry.txt"]);
    expect(trace.filter((entry) => entry === "release")).toHaveLength(4);

    // The snapshot is still discriminating rather than merely permissive: a
    // foreign file that was NOT there at entry is a genuine unexpected file
    // after the boundaries, exactly as it would be without them.
    files.set(`${DIR}/after-entry.txt`, Buffer.from("y"));
    await runCycle(f);

    const errors = f.emitted.filter((e) => e.event === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].arg).toBeInstanceOf(UsageError);
    expect((errors[0].arg as UsageError).message).toContain("after-entry.txt");
  });
});
