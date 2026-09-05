import { describe, expect, test, vi } from "vitest";
import { v4 as uuidv4 } from "uuid";

import {
  readControlFileWithGate,
  helloEnvelope,
  bilateralMismatch,
  composeDirsDisplay,
  isPeerHelloName,
  isPeerJoiningName,
  FileSyncRendezvous,
  type RendezvousDeps,
  type RendezvousOptions,
  type RendezvousScope,
} from "../../src/connection/fileSyncRendezvous";
import {
  HelloEnvelopeSchema,
  serializeEnvelope,
} from "../../src/connection/controlEnvelope";
import {
  HELLO_SUFFIX,
  JOINING_SUFFIX,
  LOCK_SUFFIX,
  ackMarkerName,
  helloTempName,
  isHelloTempName,
  isProtocolTempName,
} from "../../src/connection/fileSyncNames";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import { messageFilename } from "../../src/connection/fileSyncMessageLoop";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import type { HandshakeRole } from "../../src/types";
import { getLoggerForVerbosity } from "../../src/utils/logger";
import {
  sanitizeForDisplay,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { cancellableDelay } from "../../src/connection/fileSyncConstants";
import {
  UsageError,
  isPeerWaitTimeout,
  BilateralModeMismatchError,
  ConnectionClosedError,
} from "../../src/errors";

// A FileTransportClient stub whose only meaningful method is get(); every other
// method rejects, so a test that reaches one is a bug in the gate under test.
function stubClient(getImpl: FileTransportClient["get"]): FileTransportClient {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected ${name}() call`);
  };
  return {
    connect: unexpected("connect"),
    end: unexpected("end"),
    list: unexpected("list") as unknown as FileTransportClient["list"],
    get: getImpl,
    put: unexpected("put") as unknown as FileTransportClient["put"],
    delete: unexpected("delete"),
    safeDelete: unexpected("safeDelete"),
    rename: unexpected("rename"),
    createExclusive: unexpected("createExclusive"),
    exists: unexpected("exists") as unknown as FileTransportClient["exists"],
  };
}

const helloBuffer = (
  locklessRendezvous: boolean,
  retainFiles: boolean,
): Buffer<ArrayBufferLike> =>
  Buffer.from(
    JSON.stringify({ locklessRendezvous, retainFiles }),
  ) as Buffer<ArrayBufferLike>;

describe("bilateralMismatch", () => {
  test("reports retain_files before lockless when both flags differ", () => {
    const err = bilateralMismatch(
      { locklessRendezvous: true, retainFiles: true },
      { locklessRendezvous: false, retainFiles: false },
    );
    expect(err).toBeInstanceOf(BilateralModeMismatchError);
    expect(err?.message).toContain("retain_files mismatch");
    expect(err?.message).toContain("this party has retain_files=false");
    expect(err?.message).toContain("the peer has retain_files=true");
  });

  test("reports lockless when retain matches but lockless diverges", () => {
    const err = bilateralMismatch(
      { locklessRendezvous: true, retainFiles: false },
      { locklessRendezvous: false, retainFiles: false },
    );
    expect(err).toBeInstanceOf(BilateralModeMismatchError);
    expect(err?.message).toContain("lockless_rendezvous mismatch");
    expect(err?.message).toContain("this party has lockless_rendezvous=false");
    expect(err?.message).toContain("lockless_rendezvous=true");
  });

  test("returns undefined when both flags match", () => {
    expect(
      bilateralMismatch(
        { locklessRendezvous: true, retainFiles: false },
        { locklessRendezvous: true, retainFiles: false },
      ),
    ).toBeUndefined();
  });

  test("a connection_per_poll asymmetry does not mismatch (it is local)", () => {
    // connection_per_poll is a purely local dialing choice, not a bilateral mode
    // flag: it is never advertised in the hello, so one party may dial per-poll
    // while the other holds a session with no fast-fail. Both sides' lockless and
    // retain match here, so the mismatch check must return undefined regardless of
    // how either side dials. Built through helloEnvelope from options that hold
    // connectionPerPoll to prove the flag is dropped before the comparison.
    const dialsPerPoll = helloEnvelope({
      locklessRendezvous: false,
      retainFiles: false,
      connectionPerPoll: true,
    } as unknown as { locklessRendezvous: boolean; retainFiles: boolean });
    expect(
      bilateralMismatch(dialsPerPoll, {
        locklessRendezvous: false,
        retainFiles: false,
      }),
    ).toBeUndefined();
  });
});

describe("helloEnvelope", () => {
  test("reflects the two advertised flags", () => {
    expect(
      helloEnvelope({ locklessRendezvous: true, retainFiles: false }),
    ).toEqual({ locklessRendezvous: true, retainFiles: false });
    expect(
      helloEnvelope({ locklessRendezvous: false, retainFiles: true }),
    ).toEqual({ locklessRendezvous: false, retainFiles: true });
  });

  test("advertises only lockless and retain, never connection_per_poll", () => {
    // The party's own options hold connection_per_poll, but the advertised
    // hello must exclude it: it is a local dialing choice the peer neither
    // observes nor agrees on. A regression that added it to the envelope
    // would let it drive a spurious mismatch.
    const advertised = helloEnvelope({
      locklessRendezvous: true,
      retainFiles: false,
      connectionPerPoll: true,
    } as unknown as { locklessRendezvous: boolean; retainFiles: boolean });
    expect(advertised).toEqual({
      locklessRendezvous: true,
      retainFiles: false,
    });
    expect(advertised).not.toHaveProperty("connectionPerPoll");
  });
});

describe("HelloEnvelopeSchema", () => {
  test("strips a peer-sent connection_per_poll rather than acting on it", () => {
    // The reader's side of the same invariant: even if a peer serialized
    // connection_per_poll into its hello, the schema strips it, so it reaches no
    // comparison and cannot influence this party's rendezvous.
    const parsed = HelloEnvelopeSchema.parse({
      locklessRendezvous: false,
      retainFiles: false,
      connectionPerPoll: true,
    });
    expect(parsed).toEqual({ locklessRendezvous: false, retainFiles: false });
    expect(parsed).not.toHaveProperty("connectionPerPoll");
  });
});

describe("isPeerHelloName / isPeerJoiningName", () => {
  test("accepts a genuine peer hello and joining sentinel", () => {
    expect(isPeerHelloName("peer-1-hello.json", "self-0")).toBe(true);
    expect(isPeerJoiningName("peer-1-joining.json", "self-0")).toBe(true);
  });

  test("excludes this party's own id", () => {
    expect(isPeerHelloName("self-0-hello.json", "self-0")).toBe(false);
    expect(isPeerJoiningName("self-0-joining.json", "self-0")).toBe(false);
  });

  test("rejects a bare empty-id control name", () => {
    expect(isPeerHelloName("-hello.json", "self-0")).toBe(false);
    expect(isPeerJoiningName("-joining.json", "self-0")).toBe(false);
  });

  test("rejects a name that does not match the suffix", () => {
    expect(isPeerHelloName("peer-1-joining.json", "self-0")).toBe(false);
    expect(isPeerJoiningName("peer-1-hello.json", "self-0")).toBe(false);
  });
});

describe("readControlFileWithGate", () => {
  const future = () => new Date(Date.now() + 60_000);
  const signal = () => new AbortController().signal;

  test("rethrows a terminal UsageError from get() without retrying", async () => {
    let calls = 0;
    const terminal = new UsageError("frame too large");
    const client = stubClient(async () => {
      calls += 1;
      throw terminal;
    });
    await expect(
      readControlFileWithGate(
        client,
        "in/peer-hello.json",
        future(),
        1,
        HelloEnvelopeSchema,
        "presentAtEntry",
        signal(),
      ),
    ).rejects.toBe(terminal);
    expect(calls).toBe(1);
  });

  test("retries a transient get() failure, then resolves the parsed hello", async () => {
    let calls = 0;
    const client = stubClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("not readable yet");
      return helloBuffer(false, true);
    });
    const envelope = await readControlFileWithGate(
      client,
      "in/peer-hello.json",
      future(),
      1,
      HelloEnvelopeSchema,
      "presentAtEntry",
      signal(),
    );
    expect(envelope).toEqual({ locklessRendezvous: false, retainFiles: true });
    expect(calls).toBe(2);
  });

  test("maps a JsonStructureBoundError to a terminal malformed-payload UsageError", async () => {
    let calls = 0;
    // 4097 opening brackets exceed MAX_JSON_NESTING_DEPTH (4096), so the
    // structural pre-scan rejects the body before JSON.parse runs.
    const client = stubClient(async () => {
      calls += 1;
      return Buffer.from("[".repeat(4097)) as Buffer<ArrayBufferLike>;
    });
    await expect(
      readControlFileWithGate(
        client,
        "in/peer-hello.json",
        future(),
        1,
        HelloEnvelopeSchema,
        "presentAtEntry",
        signal(),
      ),
    ).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining(
        "malformed payload: structure exceeds the permitted bound",
      ),
    });
    expect(calls).toBe(1);
  });

  // The control file's path holds a partner-chosen filename, and both
  // malformed-payload refusals put the diagnosis BEHIND it in the same link.
  test.each([
    [
      "the structural bound",
      () => Buffer.from("[".repeat(4097)) as Buffer<ArrayBufferLike>,
      "structure exceeds the permitted bound",
    ],
    [
      "schema validation",
      () => Buffer.from("{}") as Buffer<ArrayBufferLike>,
      "malformed payload",
    ],
  ])(
    "a marker in the control file path does not suppress the %s diagnosis",
    async (_, body, diagnosis) => {
      const client = stubClient(async () => body());
      const err = await readControlFileWithGate(
        client,
        "in/-----BEGIN RSA PRIVATE KEY-----.json",
        future(),
        1,
        HelloEnvelopeSchema,
        "presentAtEntry",
        signal(),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );

      const rendered = sanitizeErrorForDisplay(err);
      expect(rendered).toContain("[redacted private key]");
      expect(rendered).toContain(diagnosis);
    },
  );

  test("names directory residue and the recovery step once the deadline has passed", async () => {
    const client = stubClient(async () => {
      throw new Error("still syncing");
    });
    let thrown: unknown;
    try {
      await readControlFileWithGate(
        client,
        "in/peer-hello.json",
        new Date(Date.now() - 1),
        1,
        HelloEnvelopeSchema,
        "presentAtEntry",
        signal(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Must NOT be a UsageError: the pre-sweep retain inspection treats a
    // UsageError from this gate as terminal and anything else as
    // retain-uncertain, so promoting this throw would turn its bounded read
    // into a hard refusal.
    expect(thrown).not.toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain("residue");
    // The re-run comes first and the removal is conditioned: the window is
    // wall-clock, so a partner slower than it is alive and mid-answer, and an
    // unconditional "remove it" would point the operator at that partner's file.
    expect((thrown as Error).message).toContain("Re-run");
    expect((thrown as Error).message).toContain("remove only if it persists");
    expect((thrown as Error).message).toContain("in/peer-hello.json");
  });

  test("attributes no residue to a hello that appeared during the run", async () => {
    const client = stubClient(async () => {
      throw new Error("still syncing");
    });
    const thrown = await readControlFileWithGate(
      client,
      "in/peer-hello.json",
      new Date(Date.now() - 1),
      1,
      HelloEnvelopeSchema,
      "appearedAfterEntry",
      signal(),
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UsageError);
    // A peer that published after this run's entry scan may simply still be
    // landing, so the message must not send the operator to delete its file.
    expect((thrown as Error).message).not.toContain("residue");
    expect((thrown as Error).message).toContain("appeared during this run");
    expect((thrown as Error).message).toContain("Re-run");
    expect((thrown as Error).message).toContain("in/peer-hello.json");
  });

  test.each([
    ["presentAtEntry", "remove only if it persists and no session shares"],
    ["appearedAfterEntry", "Re-run; remove only if it persists"],
  ] as const)(
    "the whole %s terminal message survives the display boundary for a realistic path",
    async (provenance, recoveryStep) => {
      // Every cause-chain link is truncated at DEFAULT_MAX_DISPLAY_LENGTH where
      // it is rendered, so the operative sentence, the recovery step, AND a
      // realistically long path must all fit inside one link.
      const filePath =
        "/srv/exchange/partner-drop/2f1c9a04-3b7e-4f6a-9d21-88ca0e6b5477-hello.json";
      const client = stubClient(async () => {
        throw new Error("still syncing");
      });
      const thrown = await readControlFileWithGate(
        client,
        filePath,
        new Date(Date.now() - 1),
        1,
        HelloEnvelopeSchema,
        provenance,
        signal(),
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      const rendered = sanitizeErrorForDisplay(thrown);
      expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
      expect(rendered).toContain(recoveryStep);
      expect(rendered).toContain(filePath);
    },
  );

  // The path budget is what the fixed text leaves inside one 256-character
  // cause-chain link, and it is the whole reason both texts are terse. Measured
  // rather than asserted in a comment: a text that grows past the budget cuts
  // the tail of the very path the recovery step tells the operator to act on,
  // and prose saying "only a pathologically long path can be cut" cannot fail
  // when that stops being true. The floor is set well above a realistic
  // rendezvous path (the ~92 characters of the case above) so ordinary
  // directory layouts have margin, and any edit that eats into it reddens here.
  const MIN_PATH_BUDGET = 100;
  test.each(["presentAtEntry", "appearedAfterEntry"] as const)(
    "the %s message leaves a usable path budget inside one rendered link",
    async (provenance) => {
      const client = stubClient(async () => {
        throw new Error("still syncing");
      });
      const thrown = await readControlFileWithGate(
        client,
        "",
        new Date(Date.now() - 1),
        1,
        HelloEnvelopeSchema,
        provenance,
        signal(),
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      const fixedTextLength = (thrown as Error).message.length;
      expect(
        DEFAULT_MAX_DISPLAY_LENGTH - fixedTextLength,
      ).toBeGreaterThanOrEqual(MIN_PATH_BUDGET);
    },
  );
});

// --- FileSyncRendezvous coordinator ------------------------------------------
//
// Drives the stateful coordinator directly with stub deps and an in-memory
// FileTransportClient, asserting what the class-level synchronize() tests reach
// only indirectly: the identity commit per branch, the identity reset per
// rejected path, the mismatch skip-sweep, the joiner-recovery window, live
// abort-signal cancellation, shared-Set reference identity, and the entry
// scan/sweep contract.

const DIR = "/d";

// A scripted list override: given the default listing and the (0-based) call
// index, return the listing the coordinator should observe on that poll.
type ListScript = (defaultListing: FileInfo[], call: number) => FileInfo[];

interface MemClientOptions {
  deleteThrows?: boolean;
  createExclusiveThrows?: boolean;
  existsReturns?: boolean;
  hideSelfHello?: string;
  // Names hidden from the FIRST list() (the entry scan) only, present on every
  // later poll: models a protocol file (a peer ack, lock, or hello) that a peer
  // publishes only after this party's strict-empty entry check has run.
  hideAtEntry?: string[];
  listScript?: ListScript;
}

function memClient(
  files: Map<string, Buffer>,
  opts: MemClientOptions = {},
): FileTransportClient {
  let listCall = 0;
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
      let entries = baseList(dir);
      if (opts.hideSelfHello !== undefined)
        entries = entries.filter((e) => e.name !== opts.hideSelfHello);
      if (opts.hideAtEntry !== undefined && listCall === 0)
        entries = entries.filter((e) => !opts.hideAtEntry!.includes(e.name));
      if (opts.listScript) entries = opts.listScript(entries, listCall);
      listCall += 1;
      return entries;
    },
    get: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      files.set(dest, src as Buffer);
    },
    delete: async (path: string) => {
      if (opts.deleteThrows) throw new Error("delete not supported");
      files.delete(path);
    },
    safeDelete: async (path: string) => {
      files.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
    },
    createExclusive: async (path: string) => {
      if (opts.createExclusiveThrows)
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      if (files.has(path))
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      files.set(path, Buffer.alloc(0));
    },
    exists: async (path: string) => opts.existsReturns ?? files.has(path),
  };
}

interface PartyState {
  role: string;
  peerId: string | undefined;
  handshakeRole: HandshakeRole | undefined;
  entryPeerHello: string | undefined;
  resetCount: number;
  clearCount: number;
  responsibleFiles: Set<string>;
  foreignFileSnapshot: Set<string>;
}

interface Party {
  id: string;
  options: RendezvousOptions;
  state: PartyState;
  controller: AbortController;
  client: FileTransportClient;
  files: Map<string, Buffer>;
  rdv: FileSyncRendezvous;
  scope: RendezvousScope;
}

const baseOptions = (): RendezvousOptions => ({
  timeToLive: new Date(Date.now() + 2000),
  pollingFrequency: 5,
  locklessRendezvous: false,
  retainFiles: false,
  sweepExchangeFiles: false,
  forceRetainSweep: false,
  joinerRecoveryMs: 30000,
});

function makeParty(
  id: string,
  overrides: Partial<RendezvousOptions> = {},
  files: Map<string, Buffer> = new Map(),
  clientOpts: MemClientOptions = {},
  // The rendezvous directory. DIR is two characters, which suits every test
  // that cares about protocol behavior and none that measures a message
  // against the display boundary -- there the path is part of what has to fit.
  dir: string = DIR,
): Party {
  const options: RendezvousOptions = { ...baseOptions(), ...overrides };
  const state: PartyState = {
    role: "unknown role",
    peerId: undefined,
    handshakeRole: undefined,
    entryPeerHello: undefined,
    resetCount: 0,
    clearCount: 0,
    responsibleFiles: new Set<string>(),
    foreignFileSnapshot: new Set<string>(),
  };
  const controller = new AbortController();
  const client = memClient(files, clientOpts);
  const log = getLoggerForVerbosity(`rdv-${id}`, -1);
  const deps: RendezvousDeps = {
    responsibleFiles: state.responsibleFiles,
    foreignFileSnapshot: state.foreignFileSnapshot,
    client: () => client,
    id: () => id,
    role: () => state.role,
    outbound: () => undefined,
    log: () => log,
    options: () => options,
    signal: () => controller.signal,
    wait: (ms) => cancellableDelay(ms, controller.signal),
    peerId: () => state.peerId,
    handshakeRole: () => state.handshakeRole,
    setRole: (role) => {
      state.role = role;
    },
    setPeerId: (peerId) => {
      state.peerId = peerId;
    },
    setHandshakeRole: (role) => {
      state.handshakeRole = role;
    },
    setEntryPeerHello: (name) => {
      state.entryPeerHello = name;
    },
    resetSessionState: () => {
      state.resetCount += 1;
    },
    clearAbortMarker: () => {
      state.clearCount += 1;
    },
    writeAck: async (dir, originalName) => {
      const name = ackMarkerName(id, originalName);
      const tempFile = `temp-${uuidv4()}.tmp`;
      const tempPath = `${dir}/${tempFile}`;
      try {
        await client.put(Buffer.alloc(0), tempPath, {
          flags: "w",
          encoding: null,
        });
        await client.rename(tempPath, `${dir}/${name}`);
      } catch (err) {
        await client.safeDelete(tempPath);
        throw err;
      }
      return name;
    },
  };
  return {
    id,
    options,
    state,
    controller,
    client,
    files,
    rdv: new FileSyncRendezvous(deps),
    scope: {
      inboundPath: dir,
      outboundPath: dir,
      split: false,
      dirsDisplay: dir,
    },
  };
}

const helloName = (id: string) => `${id}${HELLO_SUFFIX}`;
const helloStem = (id: string) => `${id}-hello`;

function placePeerHello(
  files: Map<string, Buffer>,
  peerId: string,
  flags: { locklessRendezvous: boolean; retainFiles: boolean },
): void {
  files.set(`${DIR}/${helloName(peerId)}`, serializeEnvelope(flags));
}

// Places the peer's zero-length ack of THIS party's hello, so the lockless
// barrier completes on the next poll.
function placePeerAckOf(
  files: Map<string, Buffer>,
  peerId: string,
  selfId: string,
): void {
  files.set(
    `${DIR}/${ackMarkerName(peerId, helloStem(selfId))}`,
    Buffer.alloc(0),
  );
}

describe("FileSyncRendezvous commit values", () => {
  test("lockless barrier commits starter/responder when this party arrived first", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    // The peer's ack is published only after this party's strict-empty entry
    // scan; the peer hello is the single tolerated entry file.
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
    });

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("starter");
    expect(p.state.handshakeRole).toBe("responder");
    expect(p.state.peerId).toBe("zzz");
  });

  test("lockless barrier commits joiner/initiator when the peer arrived first", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    placePeerHello(files, "aaa", flags);
    placePeerAckOf(files, "aaa", "zzz");
    const p = makeParty("zzz", flags, files, {
      hideAtEntry: [ackMarkerName("aaa", helloStem("zzz"))],
    });

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("joiner");
    expect(p.state.handshakeRole).toBe("initiator");
    expect(p.state.peerId).toBe("aaa");
  });

  test("lock two-hellos winner commits by filename-order tiebreak", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    // The peer hello is absent at entry (so the dispatch takes the hello-exchange
    // path, not the lock-joiner fast-path) and appears on the first poll, where
    // this party wins the createExclusive lock.
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [helloName("zzz")],
    });

    await p.rdv.run(p.scope);

    // aaa-hello.json < zzz-hello.json => arrivedFirst => starter/responder.
    expect(p.state.role).toBe("starter");
    expect(p.state.handshakeRole).toBe("responder");
    expect(p.state.peerId).toBe("zzz");
    // The winner leaves its lock on disk for the loser to clean up.
    expect(files.has(`${DIR}/aaa-zzz${LOCK_SUFFIX}`)).toBe(true);
  });

  test("lock detection (lock already present) commits at its own site", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    files.set(`${DIR}/aaa-zzz${LOCK_SUFFIX}`, Buffer.alloc(0));
    // Both peer hello and lock appear only after entry, so the barrier observes
    // a lock already present and commits through the lock-detection branch.
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [helloName("zzz"), `aaa-zzz${LOCK_SUFFIX}`],
    });

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("starter");
    expect(p.state.handshakeRole).toBe("responder");
    expect(p.state.peerId).toBe("zzz");
    // Lock-detection sweeps the lock and both hellos.
    expect(files.has(`${DIR}/aaa-zzz${LOCK_SUFFIX}`)).toBe(false);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(false);
  });

  test("EEXIST loser commits (does not hang) when the lock is claimed mid-race", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    // Peer hello appears after entry (hello-exchange path); createExclusive
    // always throws EEXIST and exists() reports the lock present, so the race
    // branch runs, tidies, and returns rather than parking.
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [helloName("zzz")],
      createExclusiveThrows: true,
      existsReturns: true,
    });

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("starter");
    expect(p.state.handshakeRole).toBe("responder");
    expect(p.state.peerId).toBe("zzz");
  });

  test("two-hellos responder branch commits when the self hello was consumed", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    // Peer hello absent at entry (hello-exchange path); during the barrier the
    // listing shows the peer hello but never this party's own hello (as if a
    // lock joiner deleted it), so the theseFiles.length === 0 responder branch
    // is taken.
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [helloName("zzz")],
      hideSelfHello: helloName("aaa"),
    });

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("starter");
    expect(p.state.handshakeRole).toBe("responder");
    expect(p.state.peerId).toBe("zzz");
  });

  test("lock-joiner fast-path commits joiner/initiator", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    const p = makeParty("aaa", flags, files);

    await p.rdv.run(p.scope);

    expect(p.state.role).toBe("joiner");
    expect(p.state.handshakeRole).toBe("initiator");
    expect(p.state.peerId).toBe("zzz");
    // The sentinel was renamed into this party's hello.
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    expect(files.has(`${DIR}/aaa${JOINING_SUFFIX}`)).toBe(false);
  });
});

describe("FileSyncRendezvous identity reset per rejected path", () => {
  const expectResetToPreSync = (state: PartyState) => {
    expect(state.peerId).toBeUndefined();
    expect(state.role).toBe("unknown role");
    expect(state.handshakeRole).toBeUndefined();
  };

  test("bilateral mismatch in the lockless barrier resets identity and skips its hello", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: true,
    });
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, retainFiles: false },
      files,
    );

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(
      BilateralModeMismatchError,
    );
    expectResetToPreSync(p.state);
    expect(p.state.clearCount).toBe(1);
    expect(p.state.resetCount).toBe(1);
    // Skip-sweep: this party's own hello stays on disk for the peer to read.
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    // No ack was written before the mismatch threw.
    expect([...files.keys()].some((k) => k.includes("-ack.json"))).toBe(false);
  });

  test("bilateral mismatch in the lock two-hellos branch resets and skips its hello", async () => {
    const files = new Map<string, Buffer>();
    // Peer is lockless while this party is a lock party: lockless_rendezvous
    // mismatch reachable at the two-hellos branch. The peer hello is hidden at
    // entry so the dispatch takes the hello-exchange path (a peer hello present
    // at entry would instead route to the lock-joiner mismatch site).
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    const p = makeParty(
      "aaa",
      { locklessRendezvous: false, retainFiles: false },
      files,
      { hideAtEntry: [helloName("zzz")] },
    );

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(
      BilateralModeMismatchError,
    );
    expectResetToPreSync(p.state);
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
  });

  test("prefix-at-dash in the lock-joiner guard resets counters but not identity", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    // Peer id is a prefix-extension of this party's id at a '-' boundary.
    placePeerHello(files, "aaa-2", flags);
    const p = makeParty("aaa", flags, files);

    const rejection = p.rdv.run(p.scope);
    await expect(rejection).rejects.toBeInstanceOf(UsageError);
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining("share a prefix at a '-' boundary"),
    });
    // The lock-joiner prefix guard fires BEFORE the identity commit, so it
    // resets session state only -- identity is never touched and no abort
    // marker is cleared.
    expect(p.state.resetCount).toBe(1);
    expect(p.state.clearCount).toBe(0);
    expect(p.state.role).toBe("unknown role");
    expect(p.state.peerId).toBeUndefined();
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
  });

  test("prefix-at-dash at the hello-exchange final gate resets committed identity", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    placePeerHello(files, "aaa-2", flags);
    placePeerAckOf(files, "aaa-2", "aaa");
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [ackMarkerName("aaa-2", helloStem("aaa"))],
    });

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(UsageError);
    // waitForPeer committed identity; the final prefix guard rolls it back.
    expectResetToPreSync(p.state);
    expect(p.state.clearCount).toBe(1);
    expect(p.state.resetCount).toBe(1);
  });

  test("TTL timeout resets identity and is not blocked on a second run", async () => {
    const p = makeParty("aaa", {
      locklessRendezvous: false,
      timeToLive: new Date(Date.now() + 40),
      pollingFrequency: 10,
    });

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("synchronization has timed out"),
    });
    expectResetToPreSync(p.state);
    // peerId undefined is exactly the precondition the connection's
    // "already synchronized" guard reads, so a retry is not blocked.
    expect(p.state.peerId).toBeUndefined();
  });
});

describe("FileSyncRendezvous mismatch skip-sweep", () => {
  test("leaves this party's own hello but removes a peer lock on mismatch", async () => {
    const files = new Map<string, Buffer>();
    // Lock present + a lockless peer hello, both surfacing only after entry: the
    // lock-detection branch reaches the bilateral check, which deletes the peer
    // lock and then throws, leaving both hellos as the terminal state.
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    files.set(`${DIR}/aaa-zzz${LOCK_SUFFIX}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      { locklessRendezvous: false, retainFiles: false },
      files,
      { hideAtEntry: [helloName("zzz"), `aaa-zzz${LOCK_SUFFIX}`] },
    );

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(
      BilateralModeMismatchError,
    );
    expect(files.has(`${DIR}/aaa-zzz${LOCK_SUFFIX}`)).toBe(false);
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });
});

const shortDeadline = () => ({
  timeToLive: new Date(Date.now() + 40),
  pollingFrequency: 10,
});

// Retain mode's rollback of a terminally failed rendezvous. These assert what
// is left ON DISK by name: responsibleFiles is retain-aware already and stays
// empty either way, so an assertion on it would pass whether or not the files
// were removed.
describe("FileSyncRendezvous terminal-failure rollback in retain mode", () => {
  const retainFlags = { locklessRendezvous: true, retainFiles: true };

  test("a peer-wait timeout with no peer removes this party's own hello", async () => {
    const files = new Map<string, Buffer>();
    const p = makeParty("aaa", { ...retainFlags, ...shortDeadline() }, files);

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("synchronization has timed out"),
    });
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
    // The whole attempt is rolled back, so the next entrant finds a clean
    // directory rather than a hello no party is behind.
    expect([...files.keys()]).toEqual([]);
  });

  test("a failure after the peer hello was acked removes this party's hello and ack", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", retainFlags);
    const p = makeParty("aaa", { ...retainFlags, ...shortDeadline() }, files);

    // The peer hello is present from the first poll, so this party acks it and
    // then polls for a return ack that never arrives.
    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("synchronization has timed out"),
    });
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
    expect(files.has(`${DIR}/${ackMarkerName("aaa", helloStem("zzz"))}`)).toBe(
      false,
    );
    // Only this party's own artifacts are rolled back; the peer's hello is the
    // peer's to remove.
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  test("a bilateral mismatch keeps this party's own hello", async () => {
    const files = new Map<string, Buffer>();
    // The peer runs lockless without retain, so the retain_files flags differ.
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    const p = makeParty("aaa", retainFlags, files);

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(
      BilateralModeMismatchError,
    );
    // The carve-out holds in retain mode too: the advertised hello is the
    // directory's terminal state, which is how the peer reaches the same
    // verdict.
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    // The mismatch is detected before the ack write, so there is none to keep.
    expect([...files.keys()].some((k) => k.includes("-ack.json"))).toBe(false);
  });
});

describe("FileSyncRendezvous joiner-recovery window", () => {
  test("fires after joinerRecoveryMs, not at the peer timeout", async () => {
    // The joining sentinel appears only after the entry scan (call >= 1) and
    // never resolves to a hello, so the lock path parks in the recovery window.
    const sentinel: FileInfo = {
      name: `zzz${JOINING_SUFFIX}`,
      modifyTime: 0,
      size: 0,
    };
    const listScript: ListScript = (entries, call) =>
      call === 0 ? entries : [...entries, sentinel];
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: false,
        joinerRecoveryMs: 60,
        pollingFrequency: 20,
        timeToLive: new Date(Date.now() + 5000),
      },
      new Map<string, Buffer>(),
      { listScript },
    );

    const start = Date.now();
    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("recovery window"),
    });
    const elapsed = Date.now() - start;
    // (joinerRecoveryMs, joinerRecoveryMs + pollingFrequency], with slack for
    // scheduler jitter -- the point is it fired well before the 5 s TTL.
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(60 + 20 + 400);
  });

  test("a different sentinel name restarts the window (never fires early)", async () => {
    // Each poll after entry shows a differently-named joining sentinel, so
    // the window restarts every cycle and the recovery abort never elapses --
    // the run instead exits at the TTL with the sentinel-preference timeout.
    const listScript: ListScript = (entries, call) =>
      call === 0
        ? entries
        : [
            ...entries,
            { name: `peer${call}${JOINING_SUFFIX}`, modifyTime: 0, size: 0 },
          ];
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: false,
        joinerRecoveryMs: 40,
        pollingFrequency: 20,
        timeToLive: new Date(Date.now() + 200),
      },
      new Map<string, Buffer>(),
      { listScript },
    );

    const start = Date.now();
    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("timed out before it completed"),
    });
    const elapsed = Date.now() - start;
    // Waited the full TTL rather than aborting at joinerRecoveryMs (40 ms).
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});

describe("FileSyncRendezvous live-signal cancellation", () => {
  test("a concurrent abort cancels an in-flight rendezvous wait promptly", async () => {
    // Empty directory: the lock path parks in waitForPeer, polling.
    const p = makeParty("aaa", {
      locklessRendezvous: false,
      pollingFrequency: 1000,
      timeToLive: new Date(Date.now() + 60000),
    });

    const closed = new ConnectionClosedError("connection closed");
    const runPromise = p.rdv.run(p.scope);
    await new Promise((r) => setTimeout(r, 20));
    p.controller.abort(closed);

    await expect(runPromise).rejects.toBe(closed);
  });
});

describe("FileSyncRendezvous shared-Set reference identity", () => {
  test("tracks hello/ack in the passed Set instance, which a cleanup sweep honors", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    const p = makeParty("aaa", flags, files, {
      hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
    });

    await p.rdv.run(p.scope);

    // The coordinator mutated the exact Set instance passed in (not a copy).
    expect(p.state.responsibleFiles.has(helloName("aaa"))).toBe(true);
    expect(
      [...p.state.responsibleFiles].some((n) => n.endsWith("-ack.json")),
    ).toBe(true);

    // Sweeping that same Set through the client removes the tracked files,
    // exactly as the connection's cleanup() does.
    for (const name of p.state.responsibleFiles)
      await p.client.safeDelete(`${DIR}/${name}`);
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
  });
});

describe("FileSyncRendezvous entry scan and sweep contract", () => {
  test("sweeps an orphaned protocol temp file and snapshots foreign files", async () => {
    const files = new Map<string, Buffer>();
    const orphan = `${DIR}/temp-${uuidv4()}.tmp`;
    files.set(orphan, Buffer.alloc(0));
    files.set(`${DIR}/leftover.txt`, Buffer.from("x"));
    // Mismatched peer hello so run() rejects deterministically after the scan.
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    const p = makeParty(
      "aaa",
      { locklessRendezvous: false, retainFiles: false },
      files,
    );

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(
      BilateralModeMismatchError,
    );
    expect(files.has(orphan)).toBe(false);
    expect(p.state.foreignFileSnapshot.has("leftover.txt")).toBe(true);
    expect(files.has(`${DIR}/leftover.txt`)).toBe(true);
  });

  test("rejects a second peer hello", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    placePeerHello(files, "yyy", flags);
    const p = makeParty("aaa", flags, files);

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("peer hello files"),
    });
  });

  test("rejects an unexpected protocol file at entry", async () => {
    const files = new Map<string, Buffer>();
    files.set(`${DIR}/x-y${LOCK_SUFFIX}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      { locklessRendezvous: false, retainFiles: false },
      files,
    );

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("unexpected protocol file"),
    });
  });

  test("--sweep-exchange-files refuses a retain signal without --force-retain-sweep", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: true,
    });
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: true,
        retainFiles: false,
        sweepExchangeFiles: true,
        forceRetainSweep: false,
      },
      files,
    );

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("retain-mode signal"),
    });
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  test("--force-retain-sweep proceeds and wipes the retain transcript", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: true,
    });
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: true,
        retainFiles: false,
        sweepExchangeFiles: true,
        forceRetainSweep: true,
        timeToLive: new Date(Date.now() + 40),
        pollingFrequency: 10,
      },
      files,
    );

    // The sweep proceeds; with the directory then empty the barrier times out.
    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(false);
  });

  test("a delete rejection during sweep shows as a transport error, not a UsageError", async () => {
    const files = new Map<string, Buffer>();
    files.set(`${DIR}/x-y${LOCK_SUFFIX}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: false,
        retainFiles: false,
        sweepExchangeFiles: true,
      },
      files,
      { deleteThrows: true },
    );

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(
      "--sweep-exchange-files failed to delete",
    );
    // Not a peer-wait timeout, so a consumer cannot offer the both-parties-swept
    // retry advice here: this directory may be only partly cleared, so the
    // advice's assumption -- that it is now empty -- does not hold.
    expect(isPeerWaitTimeout(err)).toBe(false);
  });
});

// --- entry-guard refusals at the rendered display boundary --------------------
//
// Both strict-empty refusals are what an operator acts on, and both name a
// directory path and a list of filenames whose lengths nothing in the protocol
// bounds. sanitizeErrorForDisplay caps EACH cause-chain link before joining
// them, so a refusal whose recovery step sits behind that detail loses exactly
// the part that says what to do. Asserting on the raw `.message` cannot see
// that, so every assertion below runs on the rendered string.

describe("FileSyncRendezvous entry-guard refusals at the display boundary", () => {
  // A path an operator would really configure. The rest of this suite runs on
  // the two-character DIR, which is precisely the wrong measurement here: the
  // path shares one rendered link with the filenames.
  const REAL_DIR = "/srv/exchange/partner-drop";
  const flags = { locklessRendezvous: false, retainFiles: false };

  // Two paths of the length an operator really mounts, in the split shape
  // validateSynchronizeEntry composes: the scope alone is then most of a link's
  // budget, which is the case the enumeration has to survive.
  const SPLIT_INBOUND =
    "/mnt/partner-sync/acme-health/2026/exchange-north/inbound-drop";
  const SPLIT_OUTBOUND =
    "/mnt/partner-sync/acme-health/2026/exchange-north/outbound-drop";
  // Built through the production composer, not a copy of it: these tests exist
  // to measure what an operator is shown, and a hand-composed dirsDisplay would
  // measure a shape no producer builds.
  const splitScope = (): RendezvousScope => ({
    inboundPath: SPLIT_INBOUND,
    outboundPath: SPLIT_OUTBOUND,
    split: true,
    dirsDisplay: composeDirsDisplay(SPLIT_INBOUND, SPLIT_OUTBOUND),
  });

  // The cause link holding the scope and the filenames. The renderer caps it
  // independently of the leading refusal, so it is the string the budget
  // arithmetic has to land inside.
  const detailLink = (rendered: string): string =>
    rendered.split("\ncaused by: ")[1];

  // The enumeration itself, after the `<count> <kind> in <scope>: ` prefix. The
  // scope may hold the truncation marker (it is fitted last); a filename never
  // may, which is what this slice lets a test assert.
  const enumeration = (rendered: string): string => {
    const detail = detailLink(rendered);
    return detail.slice(detail.indexOf(": ") + 2);
  };

  // The names the detail link actually shows, plus the count it says it
  // omitted. A shown name is compared against the directory's real contents, so
  // a name the cap chopped -- a partial name that reads like a whole one -- is
  // caught rather than passing as "the file was named".
  function listedNames(rendered: string): {
    shown: string[];
    omitted: number;
  } {
    const list = enumeration(rendered);
    const more = / \(and (\d+) more\)$/.exec(list);
    return {
      shown: (more ? list.slice(0, more.index) : list).split(", "),
      omitted: more ? Number(more[1]) : 0,
    };
  }

  test("the unexpected-protocol-file refusal still holds the recovery step once rendered", async () => {
    const files = new Map<string, Buffer>();
    // Retain-mode message acks: the longest protocol filename shape there is,
    // and twelve of them, so the raw enumeration alone is several times the
    // per-link cap.
    const stems = Array.from(
      { length: 12 },
      (_, i) =>
        `7c3d15be-9a02-4e88-b6f1-0d4a2739ec55-20260731T1011${String(i).padStart(2, "0")}-003-4096`,
    );
    for (const stem of stems)
      files.set(
        `${REAL_DIR}/${ackMarkerName("2f1c9a04-3b7e-4f6a-9d21-88ca0e6b5477", stem)}`,
        Buffer.alloc(0),
      );
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // The refusal and the step that clears it, which is what the operator is
    // here for, and the sweep pointer the step ends on.
    expect(rendered).toContain("must be empty except for a single peer hello");
    expect(rendered).toContain(
      "Remove them after confirming no other session is using this path",
    );
    expect(rendered).toContain("--sweep-exchange-files");
    // The refusal alone -- what an operator sees if only the leading link
    // reaches them -- has to stand on its own inside one link's budget.
    expect((err as Error).message.length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    // The detail: the directory, the true total, and whole filenames.
    expect(rendered).toContain(REAL_DIR);
    expect(rendered).toContain("12 unexpected protocol file(s)");
    const { shown, omitted } = listedNames(rendered);
    expect(shown.length).toBeGreaterThanOrEqual(1);
    for (const name of shown)
      expect(files.has(`${REAL_DIR}/${name}`)).toBe(true);
    expect(shown.length + omitted).toBe(12);
  });

  // The split scope is the one operator-facing string that puts FIRST-PARTY text
  // between two partner-influenceable paths. Redacting the composed result would
  // let a marker in the inbound path take the labels and the operator's own
  // outbound directory with it, so the composer redacts each path where it is
  // interpolated. Driven through the real refusal, because that is where the
  // composed scope is shown.
  test("a marker in the inbound path leaves the scope labels and the outbound path standing", async () => {
    // Short paths, so the whole scope fits one link: the display cap is a
    // separate bound that cuts this scope on length alone, and letting it fire
    // here would hide whether redaction stopped at the path it was given.
    const inbound = "/in/-----BEGIN RSA PRIVATE KEY-----";
    const outbound = "/out";
    const files = new Map<string, Buffer>();
    files.set(`${inbound}/${uuidv4()}${LOCK_SUFFIX}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files);

    const err = await p.rdv
      .run({
        inboundPath: inbound,
        outboundPath: outbound,
        split: true,
        dirsDisplay: composeDirsDisplay(inbound, outbound),
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain("[redacted private key]");
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // All of this sits BEHIND the planted marker and is what the fail-closed
    // rule would have eaten had the composed scope been redacted as one string.
    expect(detailLink(rendered)).toContain("(inbound) and");
    expect(detailLink(rendered)).toContain(outbound);
    expect(detailLink(rendered)).toContain("(outbound)");
    expect(detailLink(rendered)).toContain("1 unexpected protocol file(s)");
  });

  test("the peer-hello refusal's operative sentence survives rendering at a peer_id longer than a uuid", async () => {
    // A configured peer_id is not bounded to a uuid's 36 characters, and three
    // hellos is what a bilateral mismatch or a crashed run leaves behind. The
    // filenames alone are most of a link's budget, so the operative clause and
    // its closing question survive only by not riding behind them.
    const files = new Map<string, Buffer>();
    const peers = [
      "acme-health-2026-partner-exchange-north-region-01",
      "acme-health-2026-partner-exchange-south-region-02",
      "acme-health-2026-partner-exchange-west-region-03",
    ];
    for (const peer of peers)
      files.set(`${REAL_DIR}/${helloName(peer)}`, serializeEnvelope(flags));
    const p = makeParty("site-a", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(rendered).toContain(
      "only one peer may share a rendezvous directory",
    );
    expect(rendered).toContain("are there other sessions using this path?");
    expect((err as Error).message.length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    expect(rendered).toContain(REAL_DIR);
    expect(rendered).toContain("3 peer hello files");
    const { shown, omitted } = listedNames(rendered);
    for (const name of shown)
      expect(files.has(`${REAL_DIR}/${name}`)).toBe(true);
    expect(shown.length + omitted).toBe(3);
  });

  test("a split-mode scope is trimmed to make room for the names, not the other way round", async () => {
    const files = new Map<string, Buffer>();
    // Lock files under two uuid ids: an ordinary crash leftover, and long
    // enough that the scope and the enumeration cannot both be shown whole.
    const locks = Array.from(
      { length: 3 },
      () => `${uuidv4()}-${uuidv4()}${LOCK_SUFFIX}`,
    );
    for (const name of locks)
      files.set(`${SPLIT_INBOUND}/${name}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files);

    const err = await p.rdv.run(splitScope()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    // The scope is what gives way, and the inbound directory -- where these
    // files are -- survives it.
    expect(detailLink(rendered)).toContain(SPLIT_INBOUND);
    expect(enumeration(rendered)).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(detailLink(rendered)).toContain("3 unexpected protocol file(s)");
    const { shown, omitted } = listedNames(rendered);
    expect(shown.length).toBeGreaterThanOrEqual(1);
    for (const name of shown)
      expect(files.has(`${SPLIT_INBOUND}/${name}`)).toBe(true);
    expect(shown.length + omitted).toBe(3);
  });

  test("the longest name the protocol's constructors build is shown whole in that same scope", async () => {
    const files = new Map<string, Buffer>();
    // A retain-mode message ack over a timestamped message at the maximum frame
    // size: the longest filename these constructors produce for uuid
    // identities, and what the reserved name budget is sized against.
    const longest = ackMarkerName(
      uuidv4(),
      messageFilename({
        id: uuidv4(),
        timestampInFilename: true,
        byteCount: MAX_FRAME_SIZE_BYTES,
        seq: 999,
        ts: Date.UTC(2026, 6, 31, 10, 11, 0),
      }).slice(0, -".json".length),
    );
    files.set(`${SPLIT_INBOUND}/${longest}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files);

    const err = await p.rdv.run(splitScope()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    expect(enumeration(rendered)).toBe(longest);
  });

  test("a name whose escapes grow it at render time is counted, not cap-chopped", async () => {
    const files = new Map<string, Buffer>();
    // Each of these code points escapes to six characters and the backslash
    // doubles, so the name's cost in the rendered link is several times its
    // length going in. Measured on the way in it fits behind the lock file;
    // measured as rendered it does not.
    const lock = `${uuidv4()}${LOCK_SUFFIX}`;
    const escaped = `${"你".repeat(24)}\\-hello-ack.json`;
    files.set(`${REAL_DIR}/${lock}`, Buffer.alloc(0));
    files.set(`${REAL_DIR}/${escaped}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    const { shown, omitted } = listedNames(rendered);
    expect(shown).toEqual([lock]);
    expect(omitted).toBe(1);
  });

  test("a name that does not fit is skipped, not a stop on the names behind it", async () => {
    const files = new Map<string, Buffer>();
    // A lock file under a long configured peer_id, listed FIRST -- the order a
    // directory listing can hand it over, and the order a partner planting one
    // would choose. Sized inside the transport's per-name listing bound
    // (MAX_FILENAME_LENGTH, apps/cli/src/connection/listingGuard.ts), asserted
    // below, so it is a name that really reaches this guard, and still far past
    // what the enumeration's budget holds.
    const longPeerId = `${"acme-health-2026-partner-exchange-north-region-".repeat(4)}01`;
    const overlong = `${longPeerId}-${uuidv4()}${LOCK_SUFFIX}`;
    expect(overlong.length).toBeLessThanOrEqual(255);
    // The ordinary crash leftovers behind it: each fits on its own, and each
    // names a file the operator can go and delete.
    const locks = Array.from({ length: 3 }, () => `${uuidv4()}${LOCK_SUFFIX}`);
    files.set(`${REAL_DIR}/${overlong}`, Buffer.alloc(0));
    for (const name of locks) files.set(`${REAL_DIR}/${name}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    expect(detailLink(rendered)).toContain("4 unexpected protocol file(s)");
    const { shown, omitted } = listedNames(rendered);
    expect(shown).toEqual(locks);
    expect(omitted).toBe(1);
    expect(rendered).not.toContain(longPeerId.slice(0, 60));
  });

  test("a name too long for the whole budget is counted with no name shown at all", async () => {
    const files = new Map<string, Buffer>();
    // A configured peer_id has no length bound, so no reservation makes every
    // name fit. What the refusal must not do is show part of one.
    const overlong = `${"north-region-partner-".repeat(15)}hello-ack.json`;
    files.set(`${REAL_DIR}/${overlong}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    expect(detailLink(rendered)).toContain("1 unexpected protocol file(s)");
    expect(detailLink(rendered)).toContain(REAL_DIR);
    expect(enumeration(rendered)).toBe("name(s) too long to display");
    expect(rendered).not.toContain(overlong.slice(0, 30));
  });

  // Escaping happens at ONE altitude, so an escapable byte in a partner filename
  // survives to the operator escaped exactly once. Twice is not a cosmetic
  // defect: one literal backslash in a filename reaches the operator as four, so
  // the name they are told to delete is not the name on disk. Each case asserts
  // both halves -- the once-escaped form present, the twice-escaped form absent
  // -- because the presence check alone passes on the doubled output too.
  test.each([
    ["a literal backslash", "back\\slash"],
    ["a non-ASCII code point", "你好"],
    ["a control byte", "\x1b[31mred"],
    ["an astral code point", "\u{1f600}"],
  ])("a filename containing %s is escaped once, not twice", async (_, stem) => {
    const files = new Map<string, Buffer>();
    const hostile = `${stem}-lock.json`;
    files.set(`${REAL_DIR}/${hostile}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    const once = sanitizeForDisplay(hostile);
    expect(enumeration(rendered)).toBe(once);
    expect(rendered).not.toContain(sanitizeForDisplay(once));
  });

  // A filename is partner-chosen text, and the display boundary's private-key
  // redaction is fail-closed past a truncated key: from a BEGIN marker to the
  // end of its link. The name is placed FIRST, which is the order a partner
  // planting one would choose -- what the refusal is here to deliver (the count,
  // the directory to go to, and the other names to clear) is composed BEHIND it,
  // so a redaction that ran past the name would take all of it, and this
  // assertion is what would see that.
  test("a filename shaped like a private-key header does not take the enumeration with it", async () => {
    const files = new Map<string, Buffer>();
    // The name really reaches the guard: it satisfies the protocol grammar on
    // its `-lock.json` terminal, asserted below, so it classifies as an
    // unexpected protocol file rather than a tolerated foreign one.
    const planted = `-----BEGIN RSA PRIVATE KEY-----lock.json`;
    expect(planted.endsWith(LOCK_SUFFIX)).toBe(true);
    const locks = Array.from({ length: 3 }, () => `${uuidv4()}${LOCK_SUFFIX}`);
    files.set(`${REAL_DIR}/${planted}`, Buffer.alloc(0));
    for (const name of locks) files.set(`${REAL_DIR}/${name}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, REAL_DIR);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const rendered = sanitizeErrorForDisplay(err);
    // The refusal and the step that clears it, in the leading link.
    expect(rendered).toContain("must be empty except for a single peer hello");
    expect(rendered).toContain("--sweep-exchange-files");
    // The detail link: the true count, the directory, and the names behind the
    // planted one, each still whole enough to act on.
    expect(detailLink(rendered)).toContain("4 unexpected protocol file(s)");
    expect(detailLink(rendered)).toContain(REAL_DIR);
    const { shown, omitted } = listedNames(rendered);
    expect(shown.slice(1)).toEqual(locks);
    expect(omitted).toBe(0);
    // The name is redacted where it stands, and to its end: redaction inside a
    // fragment is the same fail-closed rule, so a name that IS key material is
    // taken whole rather than leaving a tail behind.
    expect(shown[0]).toBe("[redacted private key]");
    // The replacement is shorter than the shortest marker it stands in for, so
    // the budget, fitted over the raw names, still holds once it has run.
    expect(detailLink(rendered).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  // The same shape at the other composed enumeration: `<name> (<transport
  // error>)` joined with `"; "`, and the sentence that tells the operator the
  // directory is only partly swept composed after the join. This one message
  // holds the whole report, so it is measured on names short enough that the
  // per-link cap is not what decides the outcome -- suppression is.
  test("a private-key-shaped name in a sweep failure does not take the rest of the report", async () => {
    const files = new Map<string, Buffer>();
    const planted = `-----BEGIN RSA PRIVATE KEY-----lock.json`;
    const second = `b${LOCK_SUFFIX}`;
    files.set(`${DIR}/${planted}`, Buffer.alloc(0));
    files.set(`${DIR}/${second}`, Buffer.alloc(0));
    const p = makeParty("aaa", { ...flags, sweepExchangeFiles: true }, files, {
      deleteThrows: true,
    });

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain("[redacted private key]");
    // What the operator acts on, all of it composed behind the planted name.
    expect(rendered).toContain(second);
    expect(rendered).toContain(
      "The directory may be partially swept; resolve the transport error and re-run.",
    );
    // The name and its transport error are redacted separately, so the planted
    // entry keeps its own parenthetical: redacting `<name> (<error>)` as one
    // string would leave the entry reading as a bare replacement and drop the
    // reason its delete failed, which is the half that says what to fix.
    expect(rendered).toContain("[redacted private key] (delete not supported)");
  });

  // The scope is the one fragment the entry guard clips itself, and it is clipped
  // BEFORE the display boundary escapes it. Clipping a raw value on a code-point
  // boundary is what keeps the escape whole; clipping an already-escaped one
  // could leave a trailing `\u4f6` or a lone backslash on the operator's screen.
  test("a clipped directory scope never ends inside a partial escape", async () => {
    // A path long enough in RENDERED cost that the scope must be clipped: each
    // code point escapes to six characters, so 120 of them cost 720 against the
    // 256-character link.
    const hostileDir = `/${"你".repeat(120)}`;
    const files = new Map<string, Buffer>();
    files.set(`${hostileDir}/${uuidv4()}${LOCK_SUFFIX}`, Buffer.alloc(0));
    const p = makeParty("aaa", flags, files, {}, hostileDir);

    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    const detail = detailLink(sanitizeErrorForDisplay(err));
    expect(detail).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(detail.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
    const scopeShown = detail.slice(
      detail.indexOf(" in ") + " in ".length,
      detail.indexOf(DISPLAY_TRUNCATION_MARKER),
    );
    // What the operator sees is the escaping of a WHOLE code-point prefix of the
    // real path. That is stronger than "the escapes look well formed": a clip
    // taken on the ESCAPED value renders as well-formed escapes too (the sink
    // just escapes the stray backslash), but it is the escaping of no prefix of
    // anything, so an operator reading it back cannot match it to the directory.
    const codePoints = [...hostileDir];
    const wholePrefixes = codePoints.map((_, i) =>
      sanitizeForDisplay(codePoints.slice(0, i + 1).join("")),
    );
    expect(wholePrefixes).toContain(scopeShown);
  });
});

// --- connection-per-poll session boundaries ----------------------------------
//
// A transport in connection-per-poll mode drops its session between polls and
// dials a fresh one for the next cycle. The rendezvous directory lives on the
// server, so a boundary between two transport ops changes nothing durable: the
// whole handshake state is the directory plus the coordinator's function-local
// variables (FileSyncRendezvous holds no fields at all). What a boundary CAN
// expose is a publish caught between its own ops, so each forced boundary
// records the directory exactly as the fresh session would find it and the
// assertions below check that no final protocol name is ever observed
// half-published.
//
// No session transition is interposed here: the client below has no session to
// drop, so a boundary is an observation point rather than a cut. Each test
// measures the directory a fresh session would find at that point, and that the
// run reaches the same committed identity and the same final directory wherever
// the point falls. The two properties this cannot reach are checked where they
// can be: that no reconnect resets the coordinator's session state is driven
// against a cycling transport in fileSyncConnection.test.ts, and real
// server-forced cuts are driven against the SFTP server in
// apps/cli/test/integration/ephemeralSessionExchange.test.ts.
//
// Measured bound: the boundary falls BETWEEN two transport ops. A boundary that
// cuts a single op mid-flight is a different property, decided by driving the
// real SFTP server rather than modelled here.

interface SessionBoundary {
  op: string;
  contents: Array<{ name: string; body: Buffer }>;
}

// Consulted with the 0-based index of the transport op about to be issued;
// returning true places a session boundary immediately before it.
type BoundaryPredicate = (opIndex: number, op: string) => boolean;

const TRANSPORT_OPS = [
  "list",
  "get",
  "put",
  "delete",
  "safeDelete",
  "rename",
  "createExclusive",
  "exists",
] as const;

type TransportOp = (typeof TRANSPORT_OPS)[number];

// Wraps every transport method of `client` in place so a session boundary can be
// placed before a chosen op, recording the directory state a fresh session would
// find there. Returns a reader for the total op count, so a test can size its
// sweep from a boundary-free baseline run.
function installSessionBoundaries(
  client: FileTransportClient,
  files: Map<string, Buffer>,
  isBoundary: BoundaryPredicate,
  boundaries: SessionBoundary[],
): () => number {
  const methods = client as unknown as Record<
    TransportOp,
    (...args: never[]) => Promise<unknown>
  >;
  let opIndex = 0;
  for (const op of TRANSPORT_OPS) {
    const inner = methods[op].bind(client);
    methods[op] = async (...args: never[]) => {
      const at = opIndex++;
      if (isBoundary(at, op))
        boundaries.push({
          op,
          contents: [...files.entries()]
            .filter(([path]) => path.startsWith(`${DIR}/`))
            .map(([path, body]) => ({
              name: path.slice(DIR.length + 1),
              body,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        });
      return inner(...args);
    };
  }
  return () => opIndex;
}

// Fails when the fresh session would find a protocol file that is not yet
// complete: a hello or joining sentinel must hold a parseable envelope, an ack
// marker and a lock must be zero-length. A `temp-*.tmp` is the in-flight half of
// a temp-then-rename publish and is expected -- the property it exists to give
// is that the FINAL name never appears before the file is committed. Non-`.json`
// names are foreign files and hold no protocol shape to check; a `.json` name
// outside the grammar fails closed rather than passing unexamined.
function expectNoHalfPublishedFile(
  contents: Array<{ name: string; body: Buffer }>,
): void {
  for (const { name, body } of contents) {
    if (name.endsWith(".tmp") || !name.endsWith(".json")) continue;
    if (name.endsWith(HELLO_SUFFIX) || name.endsWith(JOINING_SUFFIX)) {
      expect(() =>
        HelloEnvelopeSchema.parse(JSON.parse(body.toString())),
      ).not.toThrow();
      continue;
    }
    if (name.endsWith("-ack.json") || name.endsWith(LOCK_SUFFIX)) {
      expect(body).toHaveLength(0);
      continue;
    }
    throw new Error(
      `unclassified file observed at a session boundary: ${name}`,
    );
  }
}

const namesIn = (files: Map<string, Buffer>): string[] =>
  [...files.keys()]
    .filter((path) => path.startsWith(`${DIR}/`))
    .map((path) => path.slice(DIR.length + 1));

describe("FileSyncRendezvous across connection-per-poll session boundaries", () => {
  interface BoundaryRun {
    party: Party;
    boundaries: SessionBoundary[];
    ops: number;
  }

  // The peer budget the lockless sweep below owns instead of baseOptions'
  // shared 2 s. Every assertion in that sweep is about what the directory
  // holds, never how long a step took, so this is a fallback for a peer ack
  // that never arrives -- and, since the entry-present window is not armed on a
  // budget it cannot fit strictly inside, it is also what the entry-present peer
  // hello gets to answer in. The shared 2 s is a thousand times an idle
  // position and inside one descheduling stall on a starved one: at nice 19
  // against 40 nice-0 CPU hogs on a ten-core container the sweep aborts partway
  // with "synchronization has timed out", deciding the outcome by the scheduler
  // rather than by the boundary that position placed. Both bounds here were
  // verified green under that same regime, so a later tightening has one to
  // measure against.
  //
  // The sweep's own timeout is this fallback plus one more of it: the sweep
  // spends every position's wall clock in a single test -- 20 ms idle, seven to
  // ten seconds under that regime, already past vitest's 5 s default -- and a
  // position that burns the whole rendezvous bound must still report that
  // bound's diagnosable error rather than a generic timeout.
  const SWEEP_RENDEZVOUS_HANG_BACKSTOP_MS = 30_000;

  const sweepBudget = () => ({
    timeToLive: new Date(Date.now() + SWEEP_RENDEZVOUS_HANG_BACKSTOP_MS),
  });

  // Drives one rendezvous with the boundary predicate installed, sweeping the
  // whole run once per boundary position: `baseline` measures the boundary-free op
  // count, then each position is replayed on a fresh directory.
  const sweepBoundaries = async <T extends BoundaryRun>(
    start: (isBoundary: BoundaryPredicate) => Promise<T>,
    check: (run: T) => void,
  ): Promise<void> => {
    const baseline = await start(() => false);
    expect(baseline.boundaries).toHaveLength(0);
    expect(baseline.ops).toBeGreaterThan(3);
    for (let boundary = 0; boundary < baseline.ops; boundary++) {
      const run = await start((at) => at === boundary);
      expect(run.boundaries).toHaveLength(1);
      expectNoHalfPublishedFile(run.boundaries[0].contents);
      check(run);
    }
  };

  test(
    "a lockless rendezvous commits identically at every op-boundary position",
    { timeout: SWEEP_RENDEZVOUS_HANG_BACKSTOP_MS * 2 },
    async () => {
      const start = async (
        isBoundary: BoundaryPredicate,
      ): Promise<BoundaryRun> => {
        const files = new Map<string, Buffer>();
        const flags = { locklessRendezvous: true, retainFiles: false };
        placePeerHello(files, "zzz", flags);
        placePeerAckOf(files, "zzz", "aaa");
        const party = makeParty("aaa", { ...flags, ...sweepBudget() }, files, {
          hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
        });
        const boundaries: SessionBoundary[] = [];
        const ops = installSessionBoundaries(
          party.client,
          files,
          isBoundary,
          boundaries,
        );
        await party.rdv.run(party.scope);
        return { party, boundaries, ops: ops() };
      };

      // The ack's temp-then-rename gap: the sweep must reach a boundary sitting
      // inside it, or it proves nothing about the publish it exists to protect.
      let sawAckPublishGap = false;
      const ownAck = ackMarkerName("aaa", helloStem("zzz"));
      await sweepBoundaries(start, (run) => {
        expect(run.party.state.role).toBe("starter");
        expect(run.party.state.handshakeRole).toBe("responder");
        expect(run.party.state.peerId).toBe("zzz");

        const atBoundary = run.boundaries[0].contents.map(
          (entry) => entry.name,
        );
        if (atBoundary.some((n) => n.endsWith(".tmp"))) {
          // A fresh session opening in the gap finds the in-flight temp and no
          // ack: the final name never exists half-written for the peer to match.
          expect(atBoundary).not.toContain(ownAck);
          sawAckPublishGap = true;
        }

        const names = namesIn(run.party.files);
        expect(names.filter((n) => n === helloName("aaa"))).toHaveLength(1);
        expect(names.filter((n) => n === ownAck)).toHaveLength(1);
        expect(names.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
      });
      expect(sawAckPublishGap).toBe(true);
    },
  );

  test("the lock-joiner's joining sentinel is never missing at an op-boundary position", async () => {
    const start = async (
      isBoundary: BoundaryPredicate,
    ): Promise<BoundaryRun> => {
      const files = new Map<string, Buffer>();
      const flags = { locklessRendezvous: false, retainFiles: false };
      placePeerHello(files, "zzz", flags);
      const party = makeParty("aaa", { ...flags, ...sweepBudget() }, files);
      const boundaries: SessionBoundary[] = [];
      const ops = installSessionBoundaries(
        party.client,
        files,
        isBoundary,
        boundaries,
      );
      await party.rdv.run(party.scope);
      return { party, boundaries, ops: ops() };
    };

    // The window the sentinel exists for: the peer hello has been deleted and
    // this party's hello is not yet renamed into place. A boundary inside it is
    // what the sentinel is for, so the sweep must actually reach it.
    let sawRecoveryWindow = false;
    await sweepBoundaries(start, (run) => {
      expect(run.party.state.role).toBe("joiner");
      expect(run.party.state.handshakeRole).toBe("initiator");
      expect(run.party.state.peerId).toBe("zzz");

      const atBoundary = new Set(
        run.boundaries[0].contents.map((entry) => entry.name),
      );
      if (
        !atBoundary.has(helloName("zzz")) &&
        !atBoundary.has(helloName("aaa"))
      ) {
        expect(atBoundary.has(`aaa${JOINING_SUFFIX}`)).toBe(true);
        sawRecoveryWindow = true;
      }

      const names = namesIn(run.party.files);
      expect(names.filter((n) => n === helloName("aaa"))).toHaveLength(1);
      expect(names).not.toContain(`aaa${JOINING_SUFFIX}`);
      expect(names).not.toContain(helloName("zzz"));
      expect(names.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    });
    expect(sawRecoveryWindow).toBe(true);
  });

  test("the lock file is created exactly once across every op-boundary position", async () => {
    const start = async (
      isBoundary: BoundaryPredicate,
    ): Promise<BoundaryRun & { exclusiveCreates: number }> => {
      const files = new Map<string, Buffer>();
      const flags = { locklessRendezvous: false, retainFiles: false };
      placePeerHello(files, "zzz", flags);
      // The peer hello is absent at entry, so the dispatch takes the
      // hello-exchange path and this party races the createExclusive lock.
      const party = makeParty("aaa", { ...flags, ...sweepBudget() }, files, {
        hideAtEntry: [helloName("zzz")],
      });
      const boundaries: SessionBoundary[] = [];
      const ops = installSessionBoundaries(
        party.client,
        files,
        isBoundary,
        boundaries,
      );
      let exclusiveCreates = 0;
      const innerCreate = party.client.createExclusive.bind(party.client);
      party.client.createExclusive = async (path: string) => {
        exclusiveCreates += 1;
        return innerCreate(path);
      };
      await party.rdv.run(party.scope);
      return { party, boundaries, ops: ops(), exclusiveCreates };
    };

    let sawPreLockBoundary = false;
    await sweepBoundaries(start, ({ exclusiveCreates, ...run }) => {
      expect(run.party.state.role).toBe("starter");
      expect(run.party.state.handshakeRole).toBe("responder");
      expect(run.party.state.peerId).toBe("zzz");
      // The atomic exclusive create is one op, so a boundary either precedes it
      // or follows it -- it is never re-issued into an EEXIST against itself.
      expect(exclusiveCreates).toBe(1);
      if (run.boundaries[0].op === "createExclusive") sawPreLockBoundary = true;

      const names = namesIn(run.party.files);
      expect(names.filter((n) => n === `aaa-zzz${LOCK_SUFFIX}`)).toHaveLength(
        1,
      );
      expect(run.party.files.get(`${DIR}/aaa-zzz${LOCK_SUFFIX}`)).toHaveLength(
        0,
      );
      expect(names.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    });
    expect(sawPreLockBoundary).toBe(true);
  });

  test("the zero-length ack is written once across op-boundary positions, never re-written per boundary", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    const peerAck = ackMarkerName("zzz", helloStem("aaa"));
    // The peer's ack is withheld from the first three listings, so the barrier
    // polls several times -- each poll behind its own session boundary -- after
    // this party has already written its own ack.
    const party = makeParty("aaa", { ...flags, ...sweepBudget() }, files, {
      listScript: (entries, call) =>
        call < 3 ? entries.filter((e) => e.name !== peerAck) : entries,
    });
    const boundaries: SessionBoundary[] = [];
    installSessionBoundaries(party.client, files, () => true, boundaries);
    const ackRenames: string[] = [];
    const innerRename = party.client.rename.bind(party.client);
    party.client.rename = async (from: string, to: string) => {
      if (to.endsWith("-ack.json")) ackRenames.push(to);
      return innerRename(from, to);
    };

    await party.rdv.run(party.scope);

    expect(party.state.peerId).toBe("zzz");
    // The one-time ack is a local of the single rendezvousViaHelloExchange
    // invocation, so no number of session boundaries makes the barrier re-write
    // it on a later poll.
    const ownAck = ackMarkerName("aaa", helloStem("zzz"));
    expect(ackRenames).toEqual([`${DIR}/${ownAck}`]);
    expect(files.get(`${DIR}/${ownAck}`)).toHaveLength(0);
    expect(namesIn(files).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    // The barrier really did poll across several boundaries rather than
    // completing on its first pass.
    expect(
      boundaries.filter((b) => b.op === "list").length,
    ).toBeGreaterThanOrEqual(4);
    for (const boundary of boundaries)
      expectNoHalfPublishedFile(boundary.contents);
  });

  test("the strict-empty entry guard does not re-run on a later cycle", async () => {
    const flags = { locklessRendezvous: true, retainFiles: false };
    // Control: this party's own hello present AT entry is exactly what the
    // guard rejects.
    const atEntry = new Map<string, Buffer>();
    atEntry.set(`${DIR}/${helloName("aaa")}`, serializeEnvelope(flags));
    const rejected = makeParty("aaa", flags, atEntry);
    await expect(rejected.rdv.run(rejected.scope)).rejects.toMatchObject({
      name: "UsageError",
      message: expect.stringContaining("unexpected protocol file"),
    });

    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    const party = makeParty("aaa", flags, files, {
      hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
    });
    const boundaries: SessionBoundary[] = [];
    const ops = installSessionBoundaries(
      party.client,
      files,
      () => true,
      boundaries,
    );
    const listings: string[][] = [];
    const innerList = party.client.list.bind(party.client);
    party.client.list = async (dir: string) => {
      const entries = await innerList(dir);
      listings.push(entries.map((entry) => entry.name));
      return entries;
    };

    await party.rdv.run(party.scope);

    expect(party.state.peerId).toBe("zzz");
    expect(boundaries).toHaveLength(ops());
    for (const boundary of boundaries)
      expectNoHalfPublishedFile(boundary.contents);
    expect(listings.length).toBeGreaterThan(1);
    // The entry scan ran against a directory holding only the peer hello; every
    // later listing holds the self-hello the control run above rejects, and
    // none of them re-applies the guard to it.
    expect(listings[0]).not.toContain(helloName("aaa"));
    for (const listing of listings.slice(1))
      expect(listing).toContain(helloName("aaa"));
  });

  test("the entry sweep does not re-run: this party's own hello and ack are never deleted", async () => {
    const files = new Map<string, Buffer>();
    // A crashed prior exchange's leftover for the entry sweep to clear, and a
    // foreign file the sweep never touches.
    files.set(`${DIR}/x-y${LOCK_SUFFIX}`, Buffer.alloc(0));
    files.set(`${DIR}/leftover.txt`, Buffer.from("x"));
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    placePeerAckOf(files, "zzz", "aaa");
    // Both peer files arrive after the entry scan, so the sweep sees only the
    // leftover lock and rendezvous proceeds against the swept directory.
    const party = makeParty(
      "aaa",
      {
        locklessRendezvous: true,
        retainFiles: false,
        sweepExchangeFiles: true,
        forceRetainSweep: false,
      },
      files,
      {
        hideAtEntry: [helloName("zzz"), ackMarkerName("zzz", helloStem("aaa"))],
      },
    );
    const boundaries: SessionBoundary[] = [];
    const ops = installSessionBoundaries(
      party.client,
      files,
      () => true,
      boundaries,
    );
    const removed: string[] = [];
    for (const op of ["delete", "safeDelete"] as const) {
      const inner = party.client[op].bind(party.client);
      party.client[op] = async (path: string) => {
        removed.push(path);
        return inner(path);
      };
    }

    await party.rdv.run(party.scope);

    expect(party.state.peerId).toBe("zzz");
    expect(removed).toContain(`${DIR}/x-y${LOCK_SUFFIX}`);
    expect(files.has(`${DIR}/x-y${LOCK_SUFFIX}`)).toBe(false);
    const ownAck = ackMarkerName("aaa", helloStem("zzz"));
    expect(removed).not.toContain(`${DIR}/${helloName("aaa")}`);
    expect(removed).not.toContain(`${DIR}/${ownAck}`);
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    expect(files.has(`${DIR}/${ownAck}`)).toBe(true);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    expect(files.has(`${DIR}/${ackMarkerName("zzz", helloStem("aaa"))}`)).toBe(
      true,
    );
    expect(removed).not.toContain(`${DIR}/leftover.txt`);
    expect(files.has(`${DIR}/leftover.txt`)).toBe(true);
    expect(boundaries).toHaveLength(ops());
    for (const boundary of boundaries)
      expectNoHalfPublishedFile(boundary.contents);
  });

  test("an op-boundary position mid-rendezvous does not re-enter the entry snapshot", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: true, retainFiles: false };
    files.set(`${DIR}/at-entry.txt`, Buffer.from("x"));
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    const party = makeParty("aaa", flags, files, {
      hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
    });
    const boundaries: SessionBoundary[] = [];
    installSessionBoundaries(party.client, files, () => true, boundaries);
    // A foreign file a sync tool drops in after the entry scan has run.
    let listCalls = 0;
    const innerList = party.client.list.bind(party.client);
    party.client.list = async (dir: string) => {
      if (listCalls++ === 1)
        files.set(`${DIR}/after-entry.txt`, Buffer.from("y"));
      return innerList(dir);
    };

    await party.rdv.run(party.scope);

    expect(party.state.peerId).toBe("zzz");
    expect(boundaries.length).toBeGreaterThan(3);
    // A re-entered scan would have cleared the snapshot and rebuilt it from the
    // later listing, dropping the entry-time name and adopting the later one.
    expect([...party.state.foreignFileSnapshot]).toEqual(["at-entry.txt"]);
    expect(files.has(`${DIR}/after-entry.txt`)).toBe(true);
  });
});

// --- hello publish discipline ------------------------------------------------

// Records every transport op in call order, so a test can assert what was
// written, in which order, and under which name.
function recordOps(
  client: FileTransportClient,
  log: Array<{ op: TransportOp; args: string[] }>,
): void {
  const methods = client as unknown as Record<
    TransportOp,
    (...args: never[]) => Promise<unknown>
  >;
  for (const op of TRANSPORT_OPS) {
    const inner = methods[op].bind(client);
    methods[op] = async (...args: never[]) => {
      log.push({
        op,
        args: args.filter((a) => typeof a === "string") as string[],
      });
      return inner(...args);
    };
  }
}

describe("FileSyncRendezvous hello publish discipline", () => {
  test("publishes the hello temp-then-rename, never under its final name", async () => {
    const files = new Map<string, Buffer>();
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, ...shortDeadline() },
      files,
    );
    const ops: Array<{ op: TransportOp; args: string[] }> = [];
    recordOps(p.client, ops);

    // No peer ever arrives, so the barrier times out after the hello publish.
    await expect(p.rdv.run(p.scope)).rejects.toThrow();

    const puts = ops.filter((entry) => entry.op === "put");
    expect(puts).toHaveLength(1);
    const putName = puts[0].args[0].slice(DIR.length + 1);
    // The single producer of the shape the entry sweep's exclusion recognizes:
    // if the publish and isHelloTempName ever drift apart, this fails.
    expect(isHelloTempName(putName)).toBe(true);
    const renames = ops.filter((entry) => entry.op === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0].args).toEqual([
      `${DIR}/${putName}`,
      `${DIR}/${helloName("aaa")}`,
    ]);
    // The final name is reached only by that atomic rename.
    expect(
      puts.some((entry) => entry.args[0] === `${DIR}/${helloName("aaa")}`),
    ).toBe(false);
  });

  test("writes nothing to the directory before the entry scan has listed it", async () => {
    // The assumption licensing the unconditional sweep of a message/ack temp:
    // those are written only after the peer has seen this party's hello, which
    // is published only after this listing. Both parties run this same
    // ordering, so no such temp of theirs can be in flight while this party
    // scans.
    const files = new Map<string, Buffer>();
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, ...shortDeadline() },
      files,
    );
    const ops: Array<{ op: TransportOp; args: string[] }> = [];
    recordOps(p.client, ops);

    await expect(p.rdv.run(p.scope)).rejects.toThrow();

    expect(ops[0].op).toBe("list");
    const firstWrite = ops.findIndex((entry) =>
      (["put", "rename", "createExclusive"] as TransportOp[]).includes(
        entry.op,
      ),
    );
    expect(firstWrite).toBeGreaterThan(0);
  });

  test("a hello publish that fails at the rename leaves neither the temp nor the hello", async () => {
    const files = new Map<string, Buffer>();
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, ...shortDeadline() },
      files,
    );
    p.client.rename = async () => {
      throw new Error("synthetic rename failure");
    };

    await expect(p.rdv.run(p.scope)).rejects.toThrow(
      "synthetic rename failure",
    );

    expect(namesIn(files)).toEqual([]);
  });
});

describe("FileSyncRendezvous entry temp disposition", () => {
  test("leaves a concurrently publishing peer's hello temp alone but still sweeps a message temp", async () => {
    const files = new Map<string, Buffer>();
    const peerHelloTemp = helloTempName();
    const messageTemp = `temp-${uuidv4()}.tmp`;
    files.set(`${DIR}/${peerHelloTemp}`, Buffer.from("{"));
    files.set(`${DIR}/${messageTemp}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, ...shortDeadline() },
      files,
    );

    // Entry is not aborted on either temp's account, so the run reaches the
    // barrier and times out with no peer.
    await expect(p.rdv.run(p.scope)).rejects.toThrow("timed out");

    // The peer's in-flight publish survives: deleting it would break the rename
    // it is about to perform.
    expect(files.has(`${DIR}/${peerHelloTemp}`)).toBe(true);
    expect(files.has(`${DIR}/${messageTemp}`)).toBe(false);
    // Tolerated, not reclassified: a hello temp is neither a foreign file nor an
    // unexpected protocol file.
    expect(p.state.foreignFileSnapshot.has(peerHelloTemp)).toBe(false);
    expect(isProtocolTempName(peerHelloTemp)).toBe(true);
  });

  test("--sweep-exchange-files does not delete a hello temp either", async () => {
    const files = new Map<string, Buffer>();
    const peerHelloTemp = helloTempName();
    files.set(`${DIR}/${peerHelloTemp}`, Buffer.from("{"));
    placePeerHello(files, "zzz", {
      locklessRendezvous: true,
      retainFiles: false,
    });
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: true,
        sweepExchangeFiles: true,
        ...shortDeadline(),
      },
      files,
    );

    await expect(p.rdv.run(p.scope)).rejects.toThrow("timed out");

    // The peer hello IS swept (the flag's assertion covers a durable protocol
    // file); the in-flight temp is not, because a concurrent publish is exactly
    // what the flag's assertion cannot rule out for a file this short-lived.
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(false);
    expect(files.has(`${DIR}/${peerHelloTemp}`)).toBe(true);
  });
});

// --- bounded rendezvous hello read -------------------------------------------
//
// A hello body that never resolves must not hold the operator's whole peer
// budget. The gate still tolerates a genuinely partial body -- that is what it
// exists for -- so both halves are pinned: what resolves inside the bound is
// waited for, what does not is terminal well before the TTL.

// Wraps get() so the first `failures` reads of a peer hello fail, modelling a
// body that is still syncing, after which the real body is served.
function withPartialSyncedHello(
  client: FileTransportClient,
  failures: number,
): void {
  const inner = client.get.bind(client);
  let seen = 0;
  client.get = async (path, options) => {
    if (path.endsWith(HELLO_SUFFIX) && seen++ < failures)
      throw new Error("not readable yet");
    return inner(path, options);
  };
}

describe("FileSyncRendezvous bounded hello read", () => {
  // joinerRecoveryMs floors every rendezvous bound (rendezvousBoundMs), so a
  // test that wants the read bound to expire must model a transport on which a
  // peer's publish-and-rename lands fast. At the shipped default (30 s) the
  // floor exceeds this budget and the read runs to the peer timeout instead --
  // which is the point of the floor, and is pinned separately below.
  const longBudget = () => ({
    timeToLive: new Date(Date.now() + 5000),
    pollingFrequency: 10,
    joinerRecoveryMs: 60,
  });

  // The budget for a test that drives the read to SUCCEED rather than to
  // expiry, where the bound is a fallback for a hello that never becomes
  // readable and no assertion is a duration. The floor is sized well past the
  // machine's scheduling: under longBudget's 60 ms floor a pair of injected
  // read failures costs a third of the bound on an idle container and the whole
  // of it on a loaded one, which decides the outcome by how promptly a 10 ms
  // timer fires rather than by whether the retry works.
  const readSucceedsBudget = () => ({
    timeToLive: new Date(Date.now() + 60_000),
    pollingFrequency: 10,
    joinerRecoveryMs: 15_000,
  });

  test("a torn leftover hello fails inside the read bound, not at the peer timeout (lock)", async () => {
    const files = new Map<string, Buffer>();
    // Zero length: the shape a kill between the open and the write leaves under
    // the final name. The lock party takes the joiner fast path and reads it.
    files.set(`${DIR}/${helloName("zzz")}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      { locklessRendezvous: false, ...longBudget() },
      files,
    );

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect((err as Error).message).toContain("residue");
    expect((err as Error).message).toContain(helloName("zzz"));
    // Well inside the 5 s budget the pre-bound read would have consumed.
    expect(elapsed).toBeLessThan(2000);
    // Not this party's to remove: the leftover is left exactly as found.
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  test("a torn leftover hello fails inside the read bound, not at the peer timeout (lockless)", async () => {
    const files = new Map<string, Buffer>();
    files.set(`${DIR}/${helloName("zzz")}`, Buffer.alloc(0));
    const p = makeParty(
      "aaa",
      { locklessRendezvous: true, ...longBudget() },
      files,
    );

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect((err as Error).message).toContain("residue");
    expect(elapsed).toBeLessThan(2000);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    // This party's own artifacts are still rolled back by the terminal path.
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
  });

  // The same unresolvable hello, arriving after the entry scan instead of
  // predating it: the run watched it appear, so a peer whose publish is still
  // landing explains it as well as a leftover does, and the terminal message
  // must not tell the operator to remove a live partner's file.
  test.each([
    ["lock", false],
    ["lockless", true],
  ] as const)(
    "a hello that appears after entry is not attributed to residue (%s)",
    async (_name, locklessRendezvous) => {
      const files = new Map<string, Buffer>();
      files.set(`${DIR}/${helloName("zzz")}`, Buffer.alloc(0));
      const p = makeParty(
        "aaa",
        { locklessRendezvous, ...longBudget() },
        files,
        { hideAtEntry: [helloName("zzz")] },
      );

      const started = Date.now();
      const err = await p.rdv.run(p.scope).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect((err as Error).message).not.toContain("residue");
      expect((err as Error).message).toContain("appeared during this run");
      expect((err as Error).message).toContain(helloName("zzz"));
      // Still bounded by the read window, not the peer budget.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    },
  );

  // rendezvousBoundMs floors the read bound at joinerRecoveryMs, so six cycles
  // of a fast poll do not abandon a hello that a slow transport has simply
  // not finished propagating -- six cycles at 10 ms is 60 ms, which is not a
  // round trip anywhere. The floor is still capped at the peer budget, so the
  // run ends there rather than running past what the operator asked for.
  test("the read bound is floored at joinerRecoveryMs and still capped by the budget", async () => {
    const files = new Map<string, Buffer>();
    files.set(`${DIR}/${helloName("zzz")}`, Buffer.alloc(0));
    // Shipped joinerRecoveryMs from baseOptions, not the fast-transport
    // override longBudget() applies above.
    const p = makeParty(
      "aaa",
      {
        locklessRendezvous: false,
        timeToLive: new Date(Date.now() + 1500),
        pollingFrequency: 10,
      },
      files,
    );

    const started = Date.now();
    await expect(p.rdv.run(p.scope)).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(4000);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  test("a hello still syncing within the bound is waited for, and rendezvous completes", async () => {
    const files = new Map<string, Buffer>();
    const flags = { locklessRendezvous: false, retainFiles: false };
    placePeerHello(files, "zzz", flags);
    const p = makeParty("aaa", { ...flags, ...readSucceedsBudget() }, files);
    // Two failed reads at a 10 ms cadence, well inside the bound.
    withPartialSyncedHello(p.client, 2);

    await p.rdv.run(p.scope);

    expect(p.state.peerId).toBe("zzz");
    expect(p.state.role).toBe("joiner");
  });
});

// --- entry-present peer hello ------------------------------------------------
//
// A hello already in the directory when a run starts is the only one whose
// writer has demonstrated a propagation leg, and equally the only one that can
// be residue of an interrupted run here. Two behaviors are armed on that case
// and on no other: the bounded window below, and the unconfirmed-hello fact the
// connection exposes for attribution.

// Puts Date.now under the test's own control, so a run's progress against its
// peer budget is spent where the test spends it rather than on the wall clock.
// The two boundary tests below turn on intervals narrower than a scheduler
// stall -- a listing that crosses the budget, and the skew between two clock
// readings -- which a real clock can only approximate by making them wide
// enough to outrun the scheduler, at the cost of the time it takes to do so.
// The caller restores the clock; nothing but its own advance() moves it while
// installed, so every instant a test asserts is one it chose.
function installVirtualClock(startMs: number): {
  advance: (ms: number) => void;
  restore: () => void;
} {
  let nowMs = startMs;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

// A fixed instant for the virtual clock to start from, so a failure reports the
// same numbers on every run.
const CLOCK_START_MS = 1_700_000_000_000;

describe("FileSyncRendezvous entry-present peer hello window", () => {
  const flags = { locklessRendezvous: true, retainFiles: false };
  const LEFTOVER_ID = "2f1c9a04-3b7e-4f6a-9d21-88ca0e6b5477";
  // Window = max(6 poll cycles, joinerRecoveryMs, budget/8) capped at the
  // budget: 120 ms here, comfortably inside the 3 s budget it replaces. The
  // small joinerRecoveryMs models a transport whose round trip is short enough
  // for the window to mean anything; at the shipped default the floor swallows
  // this budget whole and the window never fires early (pinned below).
  const budget = () => ({
    timeToLive: new Date(Date.now() + 3000),
    pollingFrequency: 20,
    joinerRecoveryMs: 60,
  });

  test("fails terminally within the window instead of polling to the peer timeout", async () => {
    const files = new Map<string, Buffer>();
    // A uuid peer id, the shape a default-configured run leaves behind, so the
    // rendering assertion below measures a realistic message length.
    placePeerHello(files, LEFTOVER_ID, flags);
    const p = makeParty("aaa", { ...flags, ...budget() }, files);

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("never answered");
    expect((err as Error).message).toContain(helloName(LEFTOVER_ID));
    expect(elapsed).toBeLessThan(2000);
    // Not a peer-wait timeout: this party did not wait its full budget, so a
    // consumer must not offer the advice that failure holds.
    expect(isPeerWaitTimeout(err)).toBe(false);
    // Asserted through the rendering path, which truncates each cause-chain
    // link: the diagnosis, the recovery step, and the filename all survive it.
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    // The re-run leads and the removal is conditioned on surviving it: the
    // window is wall-clock, so a partner slower than it is alive and mid-answer.
    expect(rendered).toContain("Re-run");
    expect(rendered).toContain(
      "remove only if it persists and no session shares",
    );
    expect(rendered).toContain(helloName(LEFTOVER_ID));
  });

  test("never deletes the leftover, and still rolls back this party's own files", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    const p = makeParty("aaa", { ...flags, ...budget() }, files);

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(UsageError);

    // A hello this party cannot prove is its own is not its to remove.
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    // The terminal rollback is untouched: own hello and own ack are gone.
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(false);
    expect(files.has(`${DIR}/${ackMarkerName("aaa", helloStem("zzz"))}`)).toBe(
      false,
    );
  });

  test("is armed in retain mode too", async () => {
    const retain = { locklessRendezvous: true, retainFiles: true };
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", retain);
    const p = makeParty("aaa", { ...retain, ...budget() }, files);

    const started = Date.now();
    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(UsageError);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  test("is not armed for a peer hello that appears after entry", async () => {
    // An ordinary peer arriving: it publishes its hello only after this party's
    // entry scan, so it is never timed by the window and gets the full budget.
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    const p = makeParty("aaa", { ...flags, ...budget() }, files, {
      hideAtEntry: [helloName("zzz")],
    });

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    // Waited the whole 3 s budget and failed with the ordinary timeout.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect((err as Error).message).toContain("synchronization has timed out");
    expect(isPeerWaitTimeout(err)).toBe(true);
  });

  test("a live peer that acks inside the window completes normally", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    const p = makeParty("aaa", { ...flags, ...budget() }, files, {
      hideAtEntry: [ackMarkerName("zzz", helloStem("aaa"))],
    });

    await p.rdv.run(p.scope);

    expect(p.state.peerId).toBe("zzz");
    // The peer's ack of a hello published after entry confirms a live peer, so
    // the unconfirmed-hello fact is cleared for the attribution consumer.
    expect(p.state.entryPeerHello).toBeUndefined();
  });

  test("a configured peer_id keeps its immediate entry-guard refusal", async () => {
    const files = new Map<string, Buffer>();
    files.set(
      `${DIR}/${helloName("site-a")}`,
      serializeEnvelope({ locklessRendezvous: true, retainFiles: false }),
    );
    const p = makeParty("site-a", { ...flags, ...budget() }, files);

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("unexpected protocol file");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(files.has(`${DIR}/${helloName("site-a")}`)).toBe(true);
  });

  test("records the entry-present hello for attribution and leaves it set on failure", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    const p = makeParty("aaa", { ...flags, ...budget() }, files);

    await expect(p.rdv.run(p.scope)).rejects.toBeInstanceOf(UsageError);

    // Nothing attributable to a live peer was ever observed, so the fact stands.
    expect(p.state.entryPeerHello).toBe(helloName("zzz"));
  });

  // The floor rendezvousBoundMs puts under the window, and the boundary between
  // the window and the peer budget it is weighed against.
  //
  // A budget this small cannot hold a round trip at the shipped
  // joinerRecoveryMs, so the window must not fire at all: the run reports the
  // ordinary peer-wait timeout instead of naming a hello a live-but-slow partner
  // may own. Driving two real connections over a latency-asymmetric transport,
  // the unfloored window aborted such a partner in ~650 ms and prescribed
  // removing its hello; dropping joinerRecoveryMs from the floor leaves an
  // eighth of this budget, well inside the wait asserted below.
  //
  // Deriving the window from a clock reading of its own, rather than the one
  // the deadline is measured from, exercises the split-reading path this
  // helper's single sample is designed to avoid. Under strict arming (windowMs
  // < remaining) that path cannot move the deadline past the budget either
  // way -- a later reading only shrinks the remaining budget the window is
  // checked against -- so the split reading discriminates nothing here: it
  // exercises the path, and the boundary outcome asserted below (the window
  // does not fire, the run reports the ordinary peer timeout) holds the
  // coverage. The clock spends the skew exactly where such a reading would
  // take it: the first read of timeToLive after this party's hello is on
  // disk -- the read any derivation of the remaining budget must make --
  // moves the clock SKEW_MS on, which a deadline measured from the caller's
  // own sample never sees. The poll cadence is finer than the skew, so a
  // window armed that far inside the budget would be hit by several polls
  // before it expires.
  test("does not fire on a budget too small to hold a round trip", async () => {
    const BUDGET_MS = 300;
    const SKEW_MS = 100;
    const POLL_MS = 20;
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    const timeToLive = new Date(CLOCK_START_MS + BUDGET_MS);
    const p = makeParty(
      "aaa",
      { ...flags, timeToLive, pollingFrequency: POLL_MS },
      files,
    );

    const clock = installVirtualClock(CLOCK_START_MS);
    let err: unknown;
    let ended = 0;
    try {
      // One cadence of the budget per poll, charged at the listing that opens
      // it: the run's progress toward the peer timeout, and the only spending
      // besides the skew below.
      const list = p.client.list;
      p.client.list = async (dir: string): Promise<FileInfo[]> => {
        const entries = await list(dir);
        clock.advance(POLL_MS);
        return entries;
      };
      let skewPending = false;
      const rename = p.client.rename;
      p.client.rename = async (from: string, to: string): Promise<void> => {
        await rename(from, to);
        if (to === `${DIR}/${helloName("aaa")}`) skewPending = true;
      };
      Object.defineProperty(p.options, "timeToLive", {
        get: () => {
          if (skewPending) {
            skewPending = false;
            clock.advance(SKEW_MS);
          }
          return timeToLive;
        },
      });

      err = await p.rdv.run(p.scope).then(
        () => undefined,
        (e: unknown) => e,
      );
      ended = Date.now();
    } finally {
      clock.restore();
    }

    expect(isPeerWaitTimeout(err)).toBe(true);
    expect((err as Error).message).not.toContain("residue");
    // The operator's own budget is what ended this run: no window expired
    // inside it, and the floor extended nothing past it either.
    expect(ended).toBeGreaterThanOrEqual(timeToLive.getTime());
    expect(ended).toBeLessThan(timeToLive.getTime() + BUDGET_MS);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  // The other half of that boundary: what a budget too small to arm the window
  // reports when it runs out INSIDE a poll rather than between two.
  //
  // The poll interval is how often this party looks; it says nothing about how
  // long the transport takes to answer (see rendezvousBoundMs), so a listing
  // can be entered under the budget and returned over it. Leaving the window
  // unarmed on a budget it does not fit inside is what decides the failure that
  // poll reports: a deadline capped at the budget instead sits exactly at the
  // budget's end, which this listing has already crossed, so the run attributes
  // an exhausted budget to the partner's hello -- naming it as possible residue
  // to an operator who is not there to read the difference.
  test("reports the peer timeout when a poll's own listing crosses the budget", async () => {
    const BUDGET_MS = 1000;
    const LIST_MS = 200;
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    const timeToLive = new Date(CLOCK_START_MS + BUDGET_MS);
    // The shipped joinerRecoveryMs floors the window above this budget, so
    // nothing is armed and the peer timeout is the only failure available.
    const p = makeParty(
      "aaa",
      { ...flags, timeToLive, pollingFrequency: 20 },
      files,
    );

    const clock = installVirtualClock(CLOCK_START_MS);
    let err: unknown;
    let ended = 0;
    try {
      // A transport an order of magnitude slower to answer than this party is
      // to ask, and the only spending of the budget, so it necessarily expires
      // inside a listing rather than at the loop's own check.
      const list = p.client.list;
      p.client.list = async (dir: string): Promise<FileInfo[]> => {
        const entries = await list(dir);
        clock.advance(LIST_MS);
        return entries;
      };

      err = await p.rdv.run(p.scope).then(
        () => undefined,
        (e: unknown) => e,
      );
      ended = Date.now();
    } finally {
      clock.restore();
    }

    expect(isPeerWaitTimeout(err)).toBe(true);
    expect((err as Error).message).toContain("synchronization has timed out");
    expect((err as Error).message).not.toContain("residue");
    // Ended within the listing that crossed the budget: the poll a deadline
    // capped at the budget would have failed on instead.
    expect(ended).toBeGreaterThan(timeToLive.getTime());
    expect(ended - timeToLive.getTime()).toBeLessThanOrEqual(LIST_MS);
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
  });

  // The pair a lockless run killed just after it acked leaves behind: the peer's
  // hello, and that run's own zero-length ack of it. Both residue shapes reach
  // the same class of outcome -- a terminal UsageError, bounded well inside the
  // budget, naming the file that has to go, and destroying neither -- but by
  // different guards: an ack is an unexpected protocol file, so the pair is
  // refused at entry and never reaches the unanswered-hello window the lone
  // hello is timed by.
  test("a leftover hello paired with a leftover ack of it is refused at entry", async () => {
    const KILLED_ID = "aeb0f2c1-6d5f-4a17-9c02-7e51b8d4a390";
    const files = new Map<string, Buffer>();
    placePeerHello(files, LEFTOVER_ID, flags);
    const ack = ackMarkerName(KILLED_ID, helloStem(LEFTOVER_ID));
    files.set(`${DIR}/${ack}`, Buffer.alloc(0));
    const p = makeParty("aaa", { ...flags, ...budget() }, files);

    const started = Date.now();
    const err = await p.rdv.run(p.scope).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(UsageError);
    // Bounded: the refusal lands at entry, so neither the peer-wait budget nor
    // the window inside it is what ended this run.
    expect(elapsed).toBeLessThan(1000);
    // Not a peer-wait timeout, so a consumer offers neither the both-swept
    // advice nor anything else that blames the partner for a silence this run
    // never waited out.
    expect(isPeerWaitTimeout(err)).toBe(false);
    // Attributed at the rendered boundary, which walks the cause chain: the
    // refusal and its recovery step lead, and the ack is named below them.
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
    expect(rendered).toContain("--sweep-exchange-files");
    expect(rendered).toContain(ack);
    // Neither file is this party's to remove, and the operator was just told to
    // clear them by hand.
    expect(files.has(`${DIR}/${helloName(LEFTOVER_ID)}`)).toBe(true);
    expect(files.has(`${DIR}/${ack}`)).toBe(true);
  });

  test("records nothing when no peer hello predated the run", async () => {
    const files = new Map<string, Buffer>();
    placePeerHello(files, "zzz", flags);
    placePeerAckOf(files, "zzz", "aaa");
    // Both the peer hello and its ack are published only after this party's
    // entry scan, so the run enters against an empty directory.
    const p = makeParty("aaa", { ...flags, ...budget() }, files, {
      hideAtEntry: [helloName("zzz"), ackMarkerName("zzz", helloStem("aaa"))],
    });

    await p.rdv.run(p.scope);

    expect(p.state.peerId).toBe("zzz");
    expect(p.state.entryPeerHello).toBeUndefined();
  });
});
