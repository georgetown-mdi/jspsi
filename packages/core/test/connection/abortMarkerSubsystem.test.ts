import { afterEach, expect, test, vi } from "vitest";

import { AbortMarkerSubsystem } from "../../src/connection/abortMarker";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import {
  FrameSizeExceededError,
  TransportOperationStalledError,
} from "../../src/errors";
import { fromBase64Url, toBase64Url } from "../../src/utils/crypto";

// Direct unit tests of the subsystem with injected fakes: a pass-through budget,
// a recording logger, and a client whose every method is a vi.fn(), so each
// assertion reads an argument or a return value rather than a timing outcome.

type Deps = ConstructorParameters<typeof AbortMarkerSubsystem>[0];

// Mirrored from the module-private ABORT_MARKER_WRITE_BUDGET_MS, which is also
// the decision grace period, and ABORT_MARKER_MAX_BYTES.
const WRITE_BUDGET_MS = 5000;
const MARKER_MAX_BYTES = 1024;

const TOKEN_SELF = new Uint8Array(32).fill(0x11);
const TOKEN_PEER = new Uint8Array(32).fill(0x22);
const SELF_ID = "self-id";
const PEER_ID = "peer-id";
const DIR = "/exchange";
const PEER_MARKER = `${PEER_ID}-abort.json`;

function makeClient(
  overrides: Partial<FileTransportClient> = {},
): FileTransportClient {
  return {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    get: vi.fn(async () => Buffer.alloc(0)),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    safeDelete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    createExclusive: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    beginTeardown: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Deps> = {}) {
  const debug = vi.fn();
  const stalledError = vi.fn(
    (operation: string, budgetMs: number) =>
      new TransportOperationStalledError(`${operation} (${budgetMs} ms)`),
  );
  const deps: Deps = {
    log: { debug } as unknown as Deps["log"],
    role: () => "sender",
    runBudgeted: (op) => op,
    stalledError,
    ...overrides,
  };
  return { deps, debug, stalledError };
}

function armed(
  client: FileTransportClient,
  opts: { writeDir?: string | null; deps?: Partial<Deps> } = {},
) {
  const made = makeDeps(opts.deps);
  const subsystem = new AbortMarkerSubsystem(made.deps);
  subsystem.arm(
    TOKEN_SELF,
    TOKEN_PEER,
    SELF_ID,
    opts.writeDir === null ? undefined : (opts.writeDir ?? DIR),
    client,
  );
  return { subsystem, ...made };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a new subsystem is unarmed and undecided, and seal() on it does not throw", () => {
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  expect(subsystem.armed).toBe(false);
  expect(subsystem.decisionResolved).toBe(false);
  expect(subsystem.pendingWrite).toBeUndefined();
  expect(() => subsystem.seal()).not.toThrow();
  expect(subsystem.decisionResolved).toBe(true);
});

test("arm() leaves the decision unresolved and seal() latches it", () => {
  const { subsystem } = armed(makeClient());
  expect(subsystem.armed).toBe(true);
  expect(subsystem.decisionResolved).toBe(false);
  subsystem.seal();
  expect(subsystem.decisionResolved).toBe(true);
});

test("clear() disarms and resets every piece of abort state", async () => {
  const { subsystem } = armed(makeClient());
  await subsystem.writeMarker();
  expect(subsystem.decisionResolved).toBe(true);
  expect(subsystem.pendingWrite).toBeDefined();

  subsystem.clear();
  expect(subsystem.armed).toBe(false);
  expect(subsystem.decisionResolved).toBe(false);
  expect(subsystem.pendingWrite).toBeUndefined();
});

test("awaitDecisionOrGrace resolves with the seal decision, cancels the grace timer, and never reports a timeout", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  subsystem.seal();
  const outcome = subsystem.awaitDecisionOrGrace();
  // Advancing past the grace period would turn a missing or unresolved
  // decision into "timeout"; the resolved seal must win regardless.
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("seal");
  expect(vi.getTimerCount()).toBe(0);
});

test("awaitDecisionOrGrace clears its grace timer as soon as it lands", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const outcome = subsystem.awaitDecisionOrGrace();
  expect(vi.getTimerCount()).toBe(1);
  subsystem.seal();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(await outcome).toBe("seal");
});

test("awaitDecisionOrGrace resolves with the write decision once writeMarker() pre-empts the seal", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const outcome = subsystem.awaitDecisionOrGrace();
  await subsystem.writeMarker();
  subsystem.seal();
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("write");
});

test("awaitDecisionOrGrace on an unarmed subsystem resolves as sealed without waiting", async () => {
  vi.useFakeTimers();
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  const outcome = subsystem.awaitDecisionOrGrace();
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS + 1);
  expect(await outcome).toBe("seal");
});

test("awaitDecisionOrGrace reports an undecided wait as a timeout exactly at the grace period", async () => {
  vi.useFakeTimers();
  const { subsystem } = armed(makeClient());
  const settled = vi.fn();
  void subsystem.awaitDecisionOrGrace().then(settled);
  await vi.advanceTimersByTimeAsync(WRITE_BUDGET_MS - 1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledWith("timeout");
});

test("awaitDecisionOrGrace unrefs its grace timer so it cannot hold the process open", () => {
  const unref = vi.fn();
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    () => ({ unref }) as unknown as ReturnType<typeof setTimeout>,
  );
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const { subsystem } = armed(makeClient());
  void subsystem.awaitDecisionOrGrace();
  expect(unref).toHaveBeenCalledOnce();
});

test("writeMarker puts the envelope to a temp file, renames it into place, and logs the write", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client);
  await subsystem.writeMarker();

  expect(client.beginTeardown).toHaveBeenCalledOnce();
  expect(client.put).toHaveBeenCalledOnce();
  const [body, tempPath, options] = vi.mocked(client.put).mock.calls[0];
  expect(tempPath).toMatch(
    /^\/exchange\/temp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/,
  );
  expect(options).toEqual({ flags: "w", encoding: "utf-8" });
  expect(Buffer.isBuffer(body)).toBe(true);
  expect(JSON.parse((body as Buffer).toString("utf-8"))).toEqual({
    version: 1,
    token: toBase64Url(TOKEN_SELF),
  });
  expect(client.rename).toHaveBeenCalledWith(
    tempPath,
    `${DIR}/${SELF_ID}-abort.json`,
  );
  expect(debug).toHaveBeenCalledWith(
    `[sender] wrote abort marker ${SELF_ID}-abort.json`,
  );
});

test("writeMarker on a transport without beginTeardown still gets the marker", async () => {
  const client = makeClient({ beginTeardown: undefined });
  const { subsystem } = armed(client);
  await expect(subsystem.writeMarker()).resolves.toBeUndefined();
  expect(client.rename).toHaveBeenCalledOnce();
});

test("writeMarker is memoized: every caller gets the same promise and the write runs once", async () => {
  const client = makeClient();
  const { subsystem } = armed(client);
  const first = subsystem.writeMarker();
  const second = subsystem.writeMarker();
  expect(second).toBe(first);
  expect(subsystem.pendingWrite).toBe(first);
  await first;
  expect(subsystem.writeMarker()).toBe(first);
  expect(client.put).toHaveBeenCalledOnce();
});

test("writeMarker with no outbound directory resolves without touching the transport", async () => {
  const client = makeClient();
  const { subsystem } = armed(client, { writeDir: null });
  await expect(subsystem.writeMarker()).resolves.toBeUndefined();
  expect(client.beginTeardown).not.toHaveBeenCalled();
  expect(client.put).not.toHaveBeenCalled();
  expect(client.rename).not.toHaveBeenCalled();
});

test("writeMarker on a stalled put rejects with the budget error naming the temp path", async () => {
  const client = makeClient();
  const { subsystem, stalledError } = armed(client, {
    deps: {
      runBudgeted: (_op, _budgetMs, makeError) => Promise.reject(makeError()),
    },
  });
  const rejection = await subsystem.writeMarker().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(TransportOperationStalledError);
  const tempPath = vi.mocked(client.put).mock.calls[0][1];
  expect(stalledError).toHaveBeenCalledWith(
    `abort marker write to ${tempPath}`,
    WRITE_BUDGET_MS,
  );
  expect(rejection).toBe(stalledError.mock.results[0].value);
});

test("writeMarker on a stalled rename rejects with the budget error naming the final path", async () => {
  const client = makeClient();
  const budgets: number[] = [];
  const { subsystem, stalledError, debug } = armed(client, {
    deps: {
      runBudgeted: (op, budgetMs, makeError) => {
        budgets.push(budgetMs);
        return budgets.length === 1 ? op : Promise.reject(makeError());
      },
    },
  });
  const rejection = await subsystem.writeMarker().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(budgets).toEqual([WRITE_BUDGET_MS, WRITE_BUDGET_MS]);
  expect(rejection).toBeInstanceOf(TransportOperationStalledError);
  expect(stalledError).toHaveBeenCalledWith(
    `abort marker rename to ${DIR}/${SELF_ID}-abort.json`,
    WRITE_BUDGET_MS,
  );
  expect(rejection).toBe(stalledError.mock.results[0].value);
  expect(debug).not.toHaveBeenCalled();
});

const listing = (size: number, name = PEER_MARKER): FileInfo[] => [
  { name, modifyTime: 0, size },
];
const envelope = (token: unknown, version: unknown = 1) =>
  Buffer.from(JSON.stringify({ version, token }));

test("verifyPeerMarker on an unarmed subsystem returns false without reading", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  expect(
    await subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

test("verifyPeerMarker reads a verifying marker from the inbound directory under the small cap", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
  ).toBe(true);
  expect(client.get).toHaveBeenCalledWith(`${DIR}/${PEER_MARKER}`, {
    encoding: "utf-8",
    maxBytes: MARKER_MAX_BYTES,
  });
});

test("verifyPeerMarker on a listing without the peer's marker returns false without reading", async () => {
  const client = makeClient({
    get: vi.fn(async () => envelope(toBase64Url(TOKEN_PEER))),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(80, "other-abort.json"),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

test("verifyPeerMarker logs and refuses an oversized listing", async () => {
  const client = makeClient();
  const { subsystem, debug } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(
      client,
      listing(MARKER_MAX_BYTES + 1),
      DIR,
      PEER_ID,
    ),
  ).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(
    `[sender] ignoring oversized abort marker ${PEER_MARKER} ` +
      `(${MARKER_MAX_BYTES + 1} bytes)`,
  );
});

test("verifyPeerMarker on a failed read returns false rather than throwing", async () => {
  const client = makeClient({
    get: vi.fn(async () => {
      throw new Error("read failed");
    }),
  });
  const { subsystem } = armed(client);
  expect(
    await subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
  ).toBe(false);
});

test.each([
  ["a stalled read", () => new TransportOperationStalledError("get (60 ms)")],
  ["an over-cap read", () => new FrameSizeExceededError("over the cap")],
])(
  "verifyPeerMarker rethrows %s rather than ignoring it",
  async (_label, makeError) => {
    const thrown = makeError();
    const client = makeClient({
      get: vi.fn(async () => {
        throw thrown;
      }),
    });
    const { subsystem } = armed(client);
    await expect(
      subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
    ).rejects.toBe(thrown);
  },
);

test("verifyPeerMarker refuses a non-string token even when its digits decode to the peer token", async () => {
  // A JSON number whose decimal digits are valid base64url: without the type
  // check, the decoder coerces it and the bytes match.
  const numericToken = 123412341234;
  const peerToken = fromBase64Url(String(numericToken));
  const client = makeClient({
    get: vi.fn(async () => envelope(numericToken)),
  });
  const subsystem = new AbortMarkerSubsystem(makeDeps().deps);
  subsystem.arm(TOKEN_SELF, peerToken, SELF_ID, DIR, client);
  expect(
    await subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
  ).toBe(false);

  vi.mocked(client.get).mockResolvedValue(envelope(String(numericToken)));
  expect(
    await subsystem.verifyPeerMarker(client, listing(80), DIR, PEER_ID),
  ).toBe(true);
});
