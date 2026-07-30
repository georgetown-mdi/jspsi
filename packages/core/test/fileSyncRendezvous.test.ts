import { describe, expect, test } from "vitest";
import { v4 as uuidv4 } from "uuid";

import {
  readControlFileWithGate,
  helloEnvelope,
  bilateralMismatch,
  isPeerHelloName,
  isPeerJoiningName,
  FileSyncRendezvous,
  type RendezvousDeps,
  type RendezvousOptions,
  type RendezvousScope,
} from "../src/connection/fileSyncRendezvous";
import {
  HelloEnvelopeSchema,
  serializeEnvelope,
} from "../src/connection/controlEnvelope";
import {
  HELLO_SUFFIX,
  JOINING_SUFFIX,
  LOCK_SUFFIX,
  ackMarkerName,
} from "../src/connection/fileSyncNames";
import type {
  FileInfo,
  FileTransportClient,
} from "../src/connection/fileSyncConnection";
import type { HandshakeRole } from "../src/types";
import { getLoggerForVerbosity } from "../src/utils/logger";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";
import { cancellableDelay } from "../src/connection/fileSyncConstants";
import {
  UsageError,
  isPeerWaitTimeout,
  BilateralModeMismatchError,
  ConnectionClosedError,
} from "../src/errors";

// Per-seam contract coverage for the pure rendezvous helpers. Before the split
// these were only exercised behind FileSyncConnection.synchronize(); these tests
// pin the comparison order, the name predicates, and the partial-sync gate's
// terminal/transient branches directly.

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
    // how either side dials. Built through helloEnvelope from options that carry
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
    // The party's own options carry connection_per_poll, but the advertised hello
    // must exclude it: it is a local dialing choice the peer neither observes nor
    // agrees on. A regression that added it to the envelope would let it drive a
    // spurious mismatch.
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

  test("throws a transport timeout Error once the deadline has passed", async () => {
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
        signal(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain(
      "timed out waiting for in/peer-hello.json to fully sync",
    );
  });
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
): Party {
  const options: RendezvousOptions = { ...baseOptions(), ...overrides };
  const state: PartyState = {
    role: "unknown role",
    peerId: undefined,
    handshakeRole: undefined,
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
      inboundPath: DIR,
      outboundPath: DIR,
      split: false,
      dirsDisplay: sanitizeForDisplay(DIR),
    },
  };
}

const helloName = (id: string) => `${id}${HELLO_SUFFIX}`;
const helloStem = (id: string) => `${id}-hello`;

// Places a peer's hello (with its advertised flags) in the shared directory.
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
    // listing surfaces the peer hello but never this party's own hello (as if a
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
    // Peer advertises retain_files=true; this party does not.
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

    await expect(p.rdv.run(p.scope)).rejects.toMatchObject({
      message: expect.stringContaining("share a prefix at a '-' boundary"),
    });
    // The lock-joiner prefix guard fires BEFORE the identity commit, so it
    // resets session state only -- identity is never touched and no abort
    // marker is cleared.
    expect(p.state.resetCount).toBe(1);
    expect(p.state.clearCount).toBe(0);
    expect(p.state.role).toBe("unknown role");
    expect(p.state.peerId).toBeUndefined();
    // This party's own hello was removed before throwing.
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
    // Each poll after entry surfaces a differently-named joining sentinel, so
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
    // Let the coordinator reach its first parked wait, then abort.
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
    // Orphaned temp swept during the scan; foreign file snapshotted (not swept).
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
    // Refused: the retain hello is NOT deleted.
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

  test("a delete rejection during sweep surfaces as a transport error, not a UsageError", async () => {
    const files = new Map<string, Buffer>();
    // An unexpected protocol file with no retain signal, and a transport whose
    // delete() rejects.
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
    // advice's premise -- that it is now empty -- does not hold.
    expect(isPeerWaitTimeout(err)).toBe(false);
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
// complete: a hello or joining sentinel must carry a parseable envelope, an ack
// marker and a lock must be zero-length. A `temp-*.tmp` is the in-flight half of
// a temp-then-rename publish and is expected -- the property it exists to give
// is that the FINAL name never appears before the file is committed. Non-`.json`
// names are foreign files and carry no protocol shape to check; a `.json` name
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

  test("a lockless rendezvous commits identically at every op-boundary position", async () => {
    const start = async (
      isBoundary: BoundaryPredicate,
    ): Promise<BoundaryRun> => {
      const files = new Map<string, Buffer>();
      const flags = { locklessRendezvous: true, retainFiles: false };
      placePeerHello(files, "zzz", flags);
      placePeerAckOf(files, "zzz", "aaa");
      const party = makeParty("aaa", flags, files, {
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

      const atBoundary = run.boundaries[0].contents.map((entry) => entry.name);
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
  });

  test("the lock-joiner's joining sentinel is never missing at an op-boundary position", async () => {
    const start = async (
      isBoundary: BoundaryPredicate,
    ): Promise<BoundaryRun> => {
      const files = new Map<string, Buffer>();
      const flags = { locklessRendezvous: false, retainFiles: false };
      placePeerHello(files, "zzz", flags);
      const party = makeParty("aaa", flags, files);
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
      const party = makeParty("aaa", flags, files, {
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
    const party = makeParty("aaa", flags, files, {
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
    // Every op ran on its own re-dialed session, and none of those sessions
    // opened onto a half-published file.
    expect(boundaries).toHaveLength(ops());
    for (const boundary of boundaries)
      expectNoHalfPublishedFile(boundary.contents);
    expect(listings.length).toBeGreaterThan(1);
    // The entry scan ran against a directory holding only the peer hello; every
    // later listing carries the self-hello the control run above rejects, and
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
    // The entry sweep cleared the crashed exchange's leftover...
    expect(removed).toContain(`${DIR}/x-y${LOCK_SUFFIX}`);
    expect(files.has(`${DIR}/x-y${LOCK_SUFFIX}`)).toBe(false);
    // ...and never ran again over the files this party wrote after it.
    const ownAck = ackMarkerName("aaa", helloStem("zzz"));
    expect(removed).not.toContain(`${DIR}/${helloName("aaa")}`);
    expect(removed).not.toContain(`${DIR}/${ownAck}`);
    expect(files.has(`${DIR}/${helloName("aaa")}`)).toBe(true);
    expect(files.has(`${DIR}/${ownAck}`)).toBe(true);
    // Nor over the peer's hello and ack, nor the foreign file.
    expect(files.has(`${DIR}/${helloName("zzz")}`)).toBe(true);
    expect(files.has(`${DIR}/${ackMarkerName("zzz", helloStem("aaa"))}`)).toBe(
      true,
    );
    expect(removed).not.toContain(`${DIR}/leftover.txt`);
    expect(files.has(`${DIR}/leftover.txt`)).toBe(true);
    // Every op ran on its own re-dialed session, and none of those sessions
    // opened onto a half-published file.
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
