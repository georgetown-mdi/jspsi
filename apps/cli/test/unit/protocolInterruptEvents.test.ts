import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi, test, expect, beforeEach, afterEach } from "vitest";
import type { PreparedExchange } from "@psilink/core";

// This test lives in its own file because it mocks process.exit to a no-op
// and delivers a real process.emit("SIGINT") while a live filedrop exchange
// polls -- both process-global effects a shared vitest process would
// otherwise leak into other tests, including protocol.test.ts's two-party
// rendezvous (bounded in the low hundreds of milliseconds).

// runProtocol pulls in PSI at module load; the factory is never invoked here
// (the interrupt lands before the exchange begins) but stub it so the WASM
// module is not loaded.
vi.mock("@openmined/psi.js", () => ({
  default: vi.fn().mockResolvedValue({}),
}));

// Keep @psilink/core real -- FileSyncConnection and the rendezvous especially,
// since the interrupt has to land on a live exchange -- and replace only the
// operator logger, which nothing here asserts on, and runExchange, which
// nothing here should reach.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
    }),
    runExchange: vi.fn(),
  };
});

import { runExchange } from "@psilink/core";

import { runProtocol } from "../../src/protocol";

// 32 zero bytes in base64url (43 chars, no padding).
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Unused: the exchange this value feeds is never reached.
const minimalPrepared = {} as unknown as PreparedExchange;

// fd-3 sentinel and capture: wrap writeSync so a write to the machine-interface
// descriptor (EVENT_STREAM_FD = 3) lands in a buffer -- never on the real
// descriptor, which the test process does not own -- while every other fd passes
// through. The test drains the capture and accounts for every line it caused,
// and afterEach asserts the capture is empty, so an emission the test did not
// expect fails it.
const EVENT_STREAM_FD = 3;
let fd3Chunks: Buffer[];
let realWriteSync: typeof fs.writeSync;

/** Drain the captured fd-3 bytes and return them parsed, one event per line. */
function takeFd3Lines(): Array<Record<string, unknown>> {
  const text = Buffer.concat(fd3Chunks).toString("utf8");
  fd3Chunks.length = 0;
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Make fstatSync succeed for fd 3 (pass every other target through). */
function mockFd3Open(): void {
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) return {} as fs.Stats;
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
}

let tmpDir: string;
let dropDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-proto-interrupt-"));
  dropDir = path.join(tmpDir, "drop");
  fs.mkdirSync(dropDir);

  fd3Chunks = [];
  realWriteSync = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    ...args: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) {
      const [buffer, offset, length] = args as [Buffer, number, number];
      fd3Chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
      return length;
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, ...args);
  }) as typeof fs.writeSync);
});

afterEach(() => {
  expect(fd3Chunks).toHaveLength(0);
  vi.mocked(fs.writeSync).mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a SIGINT interrupt under --event-stream emits no terminal event", async () => {
  // The contract a supervisor reads an interrupt by (docs/spec/CLI_EVENTS.md):
  // no terminal event, plus exit 130 -- otherwise the web job manager
  // synthesizes a terminal state and reports the cancellation as an outcome.
  // process.exit is mocked, the harder case: the signal handler returns
  // instead of terminating, so the interrupt hits the main catch's
  // in-flight-error path rather than the bypass a real exit gives.
  mockFd3Open();
  const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const signalListenersBefore = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
  const keyFile = path.join(tmpDir, "interrupted.key");
  const run = runProtocol({
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1, peerTimeoutMs: 5_000 },
    },
    auth: { sharedSecret: TOKEN_A, keyFilePath: keyFile },
    prepared: minimalPrepared,
    output: undefined,
    verbosity: -1,
    loggerName: "test-a",
    fileSyncRuntime: { eventStream: true },
  });
  // Observe the outcome from the moment the run exists. The interrupt settles it
  // at a moment of its own choosing, which can fall between the polls of the
  // waitFor below, and an outcome nothing is watching for is an unhandled
  // rejection rather than a test result.
  const settled = Promise.allSettled([run]);
  try {
    // Cancel once the lone inviter is waiting at the rendezvous, past the
    // prepare block and so inside the window the signal handlers cover.
    await vi.waitFor(
      () => expect(fs.readdirSync(dropDir).length).toBeGreaterThan(0),
      { timeout: 5_000 },
    );
    // A synthetic emit with no listener registered is a silent no-op, so
    // confirm the assumption the emit below rests on: the run's own handler
    // is installed and is what receives the signal.
    expect(process.listenerCount("SIGINT")).toBe(
      signalListenersBefore.SIGINT + 1,
    );
    process.emit("SIGINT");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130), {
      timeout: 5_000,
    });
    await settled;
  } finally {
    exitSpy.mockRestore();
    vi.mocked(fs.fstatSync).mockRestore();
  }

  // The interrupted run deregistered its own signal handlers before settling:
  // nothing of it is left listening on this process.
  expect(process.listenerCount("SIGINT")).toBe(signalListenersBefore.SIGINT);
  expect(process.listenerCount("SIGTERM")).toBe(signalListenersBefore.SIGTERM);
  // The signal arrived at the rendezvous, so the exchange itself never started;
  // an interrupt that landed later would exercise a different catch path than
  // the one under test.
  expect(vi.mocked(runExchange)).not.toHaveBeenCalled();

  // Nothing terminal, and no metrics summary either -- the summary is emitted
  // only immediately before a terminal event.
  const types = takeFd3Lines().map((line) => line.type);
  expect(types).not.toContain("result");
  expect(types).not.toContain("error");
  expect(types).not.toContain("metrics");
});
