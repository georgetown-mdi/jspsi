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
} from "../../src/connection/fileSyncMessageLoop";
import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import {
  serializeFileSyncMessage,
  MESSAGE_TYPE_OBJECT,
} from "../../src/connection/fileSyncFraming";
import {
  ackMarkerName,
  parseTimestampedMessageNNN,
} from "../../src/connection/fileSyncNames";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { cancellableDelay } from "../../src/connection/fileSyncConstants";
import {
  UsageError,
  BilateralModeMismatchError,
  PeerAbortError,
  FrameSizeExceededError,
  TransportPublishIndeterminateError,
} from "../../src/errors";
import { getLoggerForVerbosity } from "../../src/utils/logger";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../../src/utils/sanitizeForDisplay";
import {
  makeMockClient,
  type MockClientOptions,
  driveUntilError,
  runPoller,
  makeRendezvousPair,
  makeRetainConn,
} from "../utils/fileSyncConnectionFixture";

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
    // The malformed peer shape this scoping keeps out: the retain-mode message
    // scan reads no NNN from it, so it is the scan's rejection rather than a
    // file this baseline calls legitimate.
    expect(recognized("bob-foo-5.json")).toBe(false);
    expect(parseTimestampedMessageNNN("bob-foo-5.json")).toBeUndefined();
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
  // The peer-inactivity budget send() arms per wait, mutable so a case can give
  // the wait a budget it can actually spend within the test.
  budget: { ms: number };
  // Drives one poll cycle: arms pollerActive (as start() would) then runs poll().
  pollOnce(): Promise<void>;
}

const baseOptions = (): MessageLoopOptions => ({
  retainFiles: false,
  locklessRendezvous: false,
  timestampInFilename: false,
  // Set huge so a success-path reschedule never fires during a test; stop()
  // clears the one pending timer.
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
  const budget = { ms: 60_000 };
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
    peerBudgetMs: () => budget.ms,
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
    budget,
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
// settle. Spelled out here rather than imported so an edit to the module
// constant has to be made in both places; the two messages that hold it are
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
      // no step, and holds no tag.
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

    // What the caller is told, read where the operator reads it. send() is
    // the one publish whose recovery is established, so it restates the
    // transport's rejection, naming the message and stating that recovery,
    // tagged to suppress the CLI's generic "retry without re-inviting"
    // advisory. This remedy is the only next step printed, so it must end
    // inside the renderer's per-link cap.
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
    // second message written under it would be treated as a second message
    // rather than as the retry it is. The refusal is at send() entry, before
    // any write.
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
    // therefore hold the whole remedy and end inside the cap.
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

  // A virtual clock for the send-wait budget cases below. send() reads the clock
  // between transport calls, so charging each list() a fixed elapsed cost makes
  // the budget arithmetic exact and independent of how promptly the machine runs
  // the test -- the real poll delay stays at the fixture's 1 ms.
  function virtualClock(f: LoopFixture, msPerList: number) {
    const realNow = Date.now.bind(Date);
    const origin = realNow();
    let elapsed = 0;
    const realList = f.client.list.bind(f.client);
    f.client.list = async (dir: string) => {
      elapsed += msPerList;
      return realList(dir);
    };
    Date.now = () => origin + elapsed;
    return {
      elapsedMs: () => elapsed,
      restore: () => {
        Date.now = realNow;
      },
    };
  }

  test("each send arms its own wait budget, so a long exchange is not failed by an earlier one", async () => {
    // The wait is on peer INACTIVITY, so it is re-armed per send. Measured
    // against one absolute deadline instead, a healthy exchange that simply runs
    // longer than peer_timeout_ms reaches its next send already expired and fails
    // having waited nothing -- and a back-to-back send pair with no receive
    // between them reaches this wait on every exchange. Here two consecutive
    // waits each spend most of the budget, and their sum passes it.
    const files = new Map<string, Buffer>();
    const f = makeLoop({ pollingFrequency: 1 }, {}, files);
    f.budget.ms = 1_000;
    const clock = virtualClock(f, 400);
    try {
      // The peer consumes the outstanding message on the third listing of each
      // wait -- 800 virtual ms, inside one budget but not inside two. Each call
      // REPLACES the previous wrapper over the clock's list() rather than
      // nesting on top of it: a nested wrapper holds its counter over from the
      // earlier wait, so it would fire on the next wait's very FIRST listing and
      // that wait would never reach a third listing of its own.
      const clockList = f.client.list.bind(f.client);
      const consumedOnListing: number[] = [];
      const consumeOnThirdList = () => {
        let listings = 0;
        let consumed = false;
        f.client.list = async (dir: string) => {
          listings += 1;
          if (listings >= 3 && f.loop.lastSentFile !== undefined) {
            if (!consumed) {
              consumed = true;
              consumedOnListing.push(listings);
            }
            files.delete(`${DIR}/${f.loop.lastSentFile}`);
          }
          return clockList(dir);
        };
      };

      await expect(f.loop.send({ a: 1 })).resolves.toBeUndefined();
      consumeOnThirdList();
      await expect(f.loop.send({ a: 2 })).resolves.toBeUndefined();
      consumeOnThirdList();
      await expect(f.loop.send({ a: 3 })).resolves.toBeUndefined();
      expect(f.loop.seq).toBe(3);
      // Both waits ran to their OWN third listing, which is what makes the two
      // waits above two full waits rather than one plus a short-circuit.
      expect(consumedOnListing).toEqual([3, 3]);
      // The exchange outlived one budget, which is the case an absolute deadline
      // fails and this one must not.
      expect(clock.elapsedMs()).toBeGreaterThan(f.budget.ms);
    } finally {
      clock.restore();
    }
  });

  test("a peer that never consumes still times out inside one budget", async () => {
    // The other half of the per-send budget: re-arming it must not make the wait
    // unbounded. A peer that consumes nothing is refused within one budget plus
    // the poll step in flight when it expires.
    const files = new Map<string, Buffer>();
    const f = makeLoop({ pollingFrequency: 1 }, {}, files);
    f.budget.ms = 1_000;
    const clock = virtualClock(f, 400);
    try {
      await expect(f.loop.send({ a: 1 })).resolves.toBeUndefined();
      await expect(f.loop.send({ a: 2 })).rejects.toThrow(
        `timed out waiting for message from ${SELF} to be consumed`,
      );
      expect(clock.elapsedMs()).toBeLessThanOrEqual(f.budget.ms + 400 * 2);
    } finally {
      clock.restore();
    }
  });

  test("retain: each send arms its own ack-wait budget, so a long exchange is not failed by an earlier one", async () => {
    // The retain-mode half of the same property, on the other wait: in retain
    // mode the peer never deletes the message, so the send gate is the ack
    // marker's appearance rather than the message's disappearance. That wait is
    // re-armed per send too -- here two consecutive waits each spend most of the
    // budget and their sum passes it, which one absolute deadline would fail.
    const files = new Map<string, Buffer>();
    const f = makeLoop(
      { retainFiles: true, timestampInFilename: true, pollingFrequency: 1 },
      {},
      files,
    );
    f.budget.ms = 1_000;
    const clock = virtualClock(f, 400);
    try {
      // The peer acks on the SECOND listing of each wait -- 800 virtual ms,
      // inside one budget but not two. (Second, not third as in the
      // delete-mode pair, because that wait spends one extra listing on its
      // pre-check.) Each call REPLACES the previous wrapper rather than
      // nesting: a nested wrapper would hold over its counter and fire on
      // the next wait's first listing instead of its second.
      const clockList = f.client.list.bind(f.client);
      const ackedOnListing: number[] = [];
      const ackOnSecondList = () => {
        let listings = 0;
        let acked = false;
        f.client.list = async (dir: string) => {
          listings += 1;
          if (listings >= 2 && f.loop.lastSentFile !== undefined) {
            if (!acked) {
              acked = true;
              ackedOnListing.push(listings);
            }
            const ackName = ackMarkerName(
              PEER,
              f.loop.lastSentFile.slice(0, -".json".length),
            );
            files.set(`${DIR}/${ackName}`, Buffer.alloc(0));
          }
          return clockList(dir);
        };
      };

      await expect(f.loop.send({ a: 1 })).resolves.toBeUndefined();
      ackOnSecondList();
      await expect(f.loop.send({ a: 2 })).resolves.toBeUndefined();
      ackOnSecondList();
      await expect(f.loop.send({ a: 3 })).resolves.toBeUndefined();
      expect(f.loop.seq).toBe(3);
      // Both waits ran to their OWN second listing, which is what makes the two
      // waits above two full waits rather than one plus a short-circuit.
      expect(ackedOnListing).toEqual([2, 2]);
      // The exchange outlived one budget, which is the case an absolute deadline
      // fails and this one must not.
      expect(clock.elapsedMs()).toBeGreaterThan(f.budget.ms);
    } finally {
      clock.restore();
    }
  });

  test("retain: a peer that never acks still times out inside one budget", async () => {
    // The other half of the per-send ack budget: re-arming it must not make the
    // wait unbounded. A peer that writes no ack is refused within one budget
    // plus the poll step in flight when it expires.
    const files = new Map<string, Buffer>();
    const f = makeLoop(
      { retainFiles: true, timestampInFilename: true, pollingFrequency: 1 },
      {},
      files,
    );
    f.budget.ms = 1_000;
    const clock = virtualClock(f, 400);
    try {
      await expect(f.loop.send({ a: 1 })).resolves.toBeUndefined();
      const expectedAck = ackMarkerName(
        PEER,
        f.loop.lastSentFile!.slice(0, -".json".length),
      );
      await expect(f.loop.send({ a: 2 })).rejects.toThrow(
        `timed out waiting for ack ${expectedAck} from ${PEER}`,
      );
      expect(clock.elapsedMs()).toBeLessThanOrEqual(f.budget.ms + 400 * 2);
    } finally {
      clock.restore();
    }
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
    // list() shows the message but get() always ENOENTs (peer consumed it).
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
  test("clamps to the static cap and only ever tightens", () => {
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
// In connection-per-poll mode the loop releases the transport session at
// each idle boundary and dials a fresh one at the next cycle's start. The
// directory is server-side, so the boundary destroys nothing durable: the
// loop holds its own state across it -- the sequence shadow, entry
// foreign-file snapshot, and responsible-file set -- and only
// resetSessionState(), never the boundary, clears them.

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

// --- retain mode (retainFiles: true) -----------------------------------------

test("retain mode: synchronize() throws UsageError when locklessRendezvous is false", async () => {
  // Class-boundary guard: constructing FileSyncConnection with retainFiles:
  // true but locklessRendezvous: false (or unset) bypasses the schema refine
  // and CLI imply, so synchronize() must catch the combination and throw before
  // entering any rendezvous path.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    // locklessRendezvous intentionally omitted (defaults to false)
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: synchronize() throws UsageError when locklessRendezvous is explicitly false", async () => {
  // Explicit false must also be rejected, not just the default (unset) case.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: multi-message exchange completes when delete() always fails", async () => {
  // Acceptance: two-party unit test demonstrating a full multi-message cycle
  // when the mock's delete() is stubbed to always throw.
  const sharedFiles = new Map<string, Buffer>();
  const clientOpts: MockClientOptions = {
    files: sharedFiles,
    deleteBehavior: "throw",
    createExclusiveBehavior: "throw",
  };

  const idA = "sender-a";
  const idB = "receiver-b";
  const connA = makeRetainConn(makeMockClient(clientOpts).client, idA, idB);
  const connB = makeRetainConn(makeMockClient(clientOpts).client, idB, idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  // Send 3 messages concurrently with B's poller; the ack gate serializes
  // them even though delete() always fails.
  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
});

test("retain mode: ack marker is written before the data event fires", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

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
  conn.path = "/test";
  conn.peerId = peerId;

  let ackPresentAtEmit = false;
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => {
    ackPresentAtEmit = [...files.keys()].some(
      (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
    );
    notifyReceived();
  });

  await runPoller(conn, delivered);

  expect(ackPresentAtEmit).toBe(true);
});

// Returns the stem (name minus .json) of the single message file this party
// wrote, so a test can construct the ack the sender's gate waits for.
const lastSentStem = (files: Map<string, Buffer>, dir: string, id: string) => {
  const sent = [...files.keys()].find(
    (p) =>
      p.startsWith(`${dir}/${id}-`) &&
      p.endsWith(".json") &&
      !p.endsWith("-ack.json") &&
      !p.endsWith("-hello.json"),
  );
  if (sent === undefined) throw new Error("no sent message found");
  return sent.slice(`${dir}/`.length, -".json".length);
};

test("retain mode: sender blocks until the ack of its last message appears, then proceeds", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 50));
  expect(secondDone).toBe(false);

  // Plant the zero-length ack named after the sent message; the gate matches it
  // by name existence (constructed from the stem, not parsed).
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: an ack for a different message does not release the sender", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // An ack for a different message (a wrong stem) does not match the expected
  // name, so the gate stays closed.
  files.set(
    `/test/${peerId}-${id}-20260101T000000-999-5-ack.json`,
    Buffer.alloc(0),
  );

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // The ack of the actual last-sent message releases the gate.
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: first send proceeds immediately without any ack", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // No acks present; first send must resolve without waiting.
  await conn.send({ first: true });

  const messageFiles = [...files.keys()].filter(
    (p) =>
      p.includes(`${id}-`) && p.endsWith(".json") && !p.endsWith("-ack.json"),
  );
  expect(messageFiles).toHaveLength(1);
});

test("retain mode: cleanup() does not delete exchange files", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

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
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  await conn.cleanup();
  expect(safeDeleted).toHaveLength(0);
  const ackOnDisk = [...files.keys()].find(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBeDefined();
});

test("retain mode: a consumed message file is retained on a delete-capable transport", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  const msgPath = `/test/${msgName}`;
  files.set(msgPath, message);

  // Spy on delete() so the test fails if any deletion is attempted at all.
  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

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
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  expect(files.has(msgPath)).toBe(true);
  expect(deleted).toHaveLength(0);
  const ackOnDisk = [...files.keys()].some(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBe(true);
});

test("retain mode: a message reprocessed after an emit failure is not acked twice", async () => {
  // The ack is written before emit, and on an emit failure recvSeq stays so the
  // (never-deleted) message is reprocessed on the next poll. The ack write must
  // produce exactly one marker across that retry, even though the message is
  // processed twice.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  // Count ack writes via rename rather than the on-disk file set: the ack name
  // is a pure function of the consumed message's fixed name, so a duplicate
  // write would overwrite the first under an identical name and be invisible to
  // a file-count check.
  const ackRenames: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    if (to.endsWith("-ack.json")) ackRenames.push(to);
    return origRename(from, to);
  };

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
  conn.path = "/test";
  conn.peerId = peerId;

  // Fail the first emit so the message is reprocessed; deliver on the second.
  let emitCount = 0;
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    emitCount += 1;
    if (emitCount === 1) throw new Error("data handler failed on first emit");
    received.push(msg);
    notifyReceived();
  });
  // Swallow the error the failed emit raises through poll() so the poller keeps
  // running and reprocesses the retained message.
  conn.on("error", () => {});

  await runPoller(conn, delivered);

  expect(emitCount).toBeGreaterThanOrEqual(2);
  expect(received).toHaveLength(1);
  expect(ackRenames).toHaveLength(1);
});

test("retain mode: ack-wait timeout throws a UsageError on the peer budget", async () => {
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  // Opened rather than hand-flagged as connected: the wait's budget is the live
  // peer-inactivity budget, read from the config as boundTransport's is.
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 100 },
  });
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send arms its own budget and does not block; no ack will arrive, so
  // the second send spends its own whole budget waiting for one.
  await conn.send({ first: true });

  await expect(conn.send({ second: true })).rejects.toBeInstanceOf(UsageError);
});

test("retain mode + lockless rendezvous: multi-message exchange completes end-to-end", async () => {
  // Primary production configuration: sync-mediated transports that lack both
  // atomic exclusive-create and deletion visibility need lockless_rendezvous
  // for rendezvous AND retain_files for message-loop signaling. This test
  // covers the one combination that had zero prior coverage.
  const idA = "00000000-0000-4000-8000-000000000001"; // sorts lower
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff"; // sorts higher

  const deleteCalls: string[] = [];
  const retainOpts = {
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  };
  const { connA, connB } = makeRendezvousPair(
    idA,
    retainOpts,
    idB,
    retainOpts,
    {
      client: {
        deleteBehavior: "throw",
        createExclusiveBehavior: "throw",
        onDelete: (path) => deleteCalls.push(path),
      },
      timeToLiveMs: 5_000,
      pollingFrequency: 10,
    },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
  // delete() was never called: retain mode on a no-delete transport must not
  // attempt deletion anywhere in the rendezvous-to-message-loop path.
  expect(deleteCalls).toHaveLength(0);
});

// --- send() advances seq only after the durable rename -----------------------

test("retain mode: send() does not advance seq when rename throws", async () => {
  // Regression guard: a write failure must not leave this.seq past the slot of
  // the unwritten message, which would cause the retain-mode ack gate to wait
  // forever for the ack of a message that was never written.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = "sender-me";
  conn.peerId = "peer-receiver";

  const seqBefore = conn.seq;

  client.rename = async () => {
    throw new Error("rename failed");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("rename failed");

  // seq must be unchanged: the message was never committed to disk.
  expect(conn.seq).toBe(seqBefore);
});

// --- retain => timestampInFilename guard in synchronize() --------------------

test("retain mode: synchronize() throws UsageError when timestampInFilename is false", async () => {
  // Guard fires when retainFiles=true and timestampInFilename=false (even when
  // locklessRendezvous=true, so it is the timestamp guard that triggers).
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: true,
    timestampInFilename: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: poll() duplicate-NNN error is a UsageError and stops the poller", async () => {
  // The duplicate-NNN throw is a UsageError (terminal protocol violation). A
  // UsageError in the non-TOCTOU catch branch sets pollerActive=false before
  // emitting, so the finally block does not reschedule and the error fires
  // exactly once without the handler calling stop().
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant two message files with the same NNN (0): the poller scan for
  // recvSeq=0 will find both and throw the duplicate-NNN UsageError.
  const msg = objectMessage({ v: 1 });
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);
  files.set(`/test/${peerId}-20260101T120000-000-${msg.length}.json`, msg);

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
  conn.path = "/test";
  conn.peerId = peerId;

  // Do NOT stop the poller in the handler: it must stop itself before the emit
  // so the finally block does not reschedule. The settle gives a wrong
  // reschedule two poll intervals to show up as a second error.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn, {
    settleMs: 50,
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");

  // pollerActive must be false: the poller stopped itself before emitting.
  expect(pollerActiveBeforeDriverStop).toBe(false);
});

test("retain mode: poll() seq-mismatch (UsageError) stops the poller", async () => {
  // The seq-mismatch UsageError also stops the poller, consistent with the
  // duplicate-NNN path above.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant a message whose body seq disagrees with the filename NNN (NNN=0,
  // body seq=99). The validator throws UsageError on the mismatch.
  const msg = objectMessage({ v: 1 }, 99);
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);

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
  conn.path = "/test";
  conn.peerId = peerId;

  // Do NOT stop the poller in the handler: it must stop itself. The settle gives
  // a wrong reschedule time to trigger a second error.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn, {
    settleMs: 50,
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("seq=");

  expect(pollerActiveBeforeDriverStop).toBe(false);
});

test("retain mode: send() honors an ack already on disk even when its peer budget is spent", async () => {
  // Regression guard for the ack-gate ordering: the wait checks for the
  // qualifying ack BEFORE its deadline, so an already-written ack is honored
  // rather than discarded as a spurious timeout. What bounds this wait is
  // the peer-inactivity budget armed at THIS send (peerTimeoutMs, via
  // open(), not a hand-flagged connection), not the connection's timeToLive.
  //
  // It is armed by a clock that jumps two budgets on every reading, so any
  // LATER reading is already past the deadline. The real ordering never
  // takes a later reading -- it lists, finds the ack, and breaks -- while a
  // deadline-first loop would read a spent budget and throw before listing.
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";
  const PEER_BUDGET_MS = 100;
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: PEER_BUDGET_MS },
  });
  conn.id = id;
  conn.peerId = peerId;

  // First send (seq=0) passes the gate without waiting and records the sent
  // message as lastSentFile. Plant the ack of that message so the next send's
  // gate finds it on its first check.
  await conn.send({ n: 1 });
  const stem = lastSentStem(files, "/test", id);
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  const realNow = Date.now.bind(Date);
  const origin = realNow();
  let readings = 0;
  Date.now = () => origin + readings++ * PEER_BUDGET_MS * 2;
  let listings = 0;
  const realList = client.list.bind(client);
  client.list = async (p: string) => {
    listings += 1;
    return realList(p);
  };

  try {
    await expect(conn.send({ n: 2 })).resolves.toBeUndefined();
    expect(conn.seq).toBe(2);
    // One listing: the ack was honored on the wait's first check, before the
    // spent deadline could be consulted at all.
    expect(listings).toBe(1);
  } finally {
    Date.now = realNow;
  }
});

test("retain mode: writeAck is deterministic and idempotent by name (hyphen-containing id)", async () => {
  // The marker name is a pure function of this party's id and the acknowledged
  // file's fixed name, so two writes for the same message yield the identical
  // name and a single zero-length file -- no duplicate even if the per-message
  // write guard is bypassed. `site-a` exercises a hyphen-containing id, proving
  // the name is built by concatenation and never split back into ids.
  const { client, files } = makeMockClient();
  const conn = makeRetainConn(client, "site-a", "b"); // path "/shared"
  const writeAck = (
    conn as unknown as {
      writeAck: (dir: string, originalName: string) => Promise<string>;
    }
  ).writeAck.bind(conn);

  const messageName = "b-20260101T000000-000-42.json";
  const originalName = messageName.slice(0, -".json".length);

  const first = await writeAck("/shared", originalName);
  const second = await writeAck("/shared", originalName);

  expect(first).toBe("site-a-b-20260101T000000-000-42-ack.json");
  expect(second).toBe(first);
  const acks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(acks).toHaveLength(1);
  expect(files.get(`/shared/${first}`)!.length).toBe(0);
});

test("retain mode: a peer message with a valid byte count but unparseable NNN is a terminal error regardless of unexpected_files", async () => {
  for (const policy of ["error", "warn", "ignore"] as const) {
    const { client, files } = makeMockClient();
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 10,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
      unexpectedFiles: policy,
    });
    conn.id = "me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer";

    // Byte-count terminal (5) but the NNN segment ("foo") is non-numeric.
    files.set("/test/peer-foo-5.json", Buffer.from("xxxxx"));

    const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(
      conn,
      {
        timeoutMessage: `timed out (policy=${policy})`,
      },
    );

    expect(errors).toHaveLength(1);
    // A malformed-protocol UsageError, NOT a bilateral-mismatch: both sides
    // already agreed on retain/timestamp at rendezvous, so a "your settings
    // disagree" message would misdirect the operator.
    expect(errors[0]).toBeInstanceOf(UsageError);
    expect(errors[0]).not.toBeInstanceOf(BilateralModeMismatchError);
    expect((errors[0] as Error).message).toContain("peer-foo-5.json");
    expect((errors[0] as Error).message).toContain("NNN");
    expect(pollerActiveBeforeDriverStop).toBe(false);
  }
});
