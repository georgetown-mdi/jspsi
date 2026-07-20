import { describe, expect, test } from "vitest";

import {
  readControlFileWithGate,
  helloEnvelope,
  bilateralMismatch,
  isPeerHelloName,
  isPeerJoiningName,
} from "../src/connection/fileSyncRendezvous";
import { HelloEnvelopeSchema } from "../src/connection/controlEnvelope";
import type { FileTransportClient } from "../src/connection/fileSyncConnection";
import { UsageError, BilateralModeMismatchError } from "../src/errors";

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
