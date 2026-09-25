import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ConnectionError,
  FileSyncConnection,
  fromEventConnection,
  TransportPublishIndeterminateError,
  UsageError,
} from "@alcove/core";
import type { FileInfo, MessageConnection } from "@alcove/core";

import {
  directoryTooLargeError,
  listingStalledByTimeoutError,
} from "../../../src/connection/listingGuard";
import { LocalFSClient } from "../../../src/connection/localFSClient";
import { midExchangeReconnectBudgetExhaustedError } from "../../../src/connection/sftpAdapterWarnings";
import { exitCodeForError } from "../../../src/util/exit";

// A usage fault the file-sync transport raises mid-exchange reaches a command
// boundary through the message bridge, which wraps every send and poll failure
// as a `transport`-kind ConnectionError. Each case drives the real
// FileSyncConnection over the CLI's filedrop client, through the real bridge,
// into the real exit mapping, and asserts the spec's 64 rather than the 69 a
// transport failure takes.

const A = "party-a";
const B = "party-b";

// A filedrop client whose list() or message rename a case can fail on demand,
// with the error the real adapter or guard would raise.
class FaultingClient extends LocalFSClient {
  listFault: (() => Error) | undefined;
  renameFault: ((toPath: string) => Error | undefined) | undefined;

  override async list(dir: string): Promise<FileInfo[]> {
    if (this.listFault !== undefined) throw this.listFault();
    return super.list(dir);
  }

  override async rename(fromPath: string, toPath: string): Promise<void> {
    const fault = this.renameFault?.(toPath);
    if (fault !== undefined) throw fault;
    return super.rename(fromPath, toPath);
  }
}

let tmpDir: string;
let dropDir: string;
let open: FileSyncConnection[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-bridged-usage-"));
  dropDir = path.join(tmpDir, "drop");
  fs.mkdirSync(dropDir);
  open = [];
});

afterEach(async () => {
  for (const conn of open) conn.stop();
  await Promise.allSettled(open.map((conn) => conn.close()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Two parties rendezvous in one directory; only A's poller runs, so B never
// consumes, and A is bridged the way runProtocol bridges it. The bridge's own
// inactivity bound is set past every case, so what fails a case is the
// transport's refusal rather than the bridge's timer.
async function rendezvous(peerTimeoutMs = 60_000): Promise<{
  client: FaultingClient;
  connA: FileSyncConnection;
  bridge: MessageConnection;
}> {
  const client = new FaultingClient();
  const connA = new FileSyncConnection(client, {
    verbose: -1,
    pollingFrequency: 10,
    peerId: A,
  });
  const connB = new FileSyncConnection(new LocalFSClient(), {
    verbose: -1,
    pollingFrequency: 10,
    peerId: B,
  });
  open.push(connA, connB);
  const config = {
    channel: "filedrop" as const,
    path: dropDir,
    options: { peerTimeoutMs },
  };
  await Promise.all([connA.open(config), connB.open(config)]);
  await Promise.all([connA.synchronize(), connB.synchronize()]);
  const bridge = fromEventConnection(connA, { inactivityTimeoutMs: 120_000 });
  connA.start();
  return { client, connA, bridge };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await Promise.allSettled([promise]);
  expect(outcome[0].status).toBe("rejected");
  return (outcome[0] as PromiseRejectedResult).reason;
}

// What every case asserts: the bridge wrapped the transport's usage fault, and
// the exit mapping still reports 64 for it.
function expectBridgedUsageExit(
  err: unknown,
  cause: RegExp | (new (...args: never[]) => Error),
): void {
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  const wrapped = (err as Error).cause;
  expect(wrapped).toBeInstanceOf(UsageError);
  if (cause instanceof RegExp)
    expect((wrapped as Error).message).toMatch(cause);
  else expect(wrapped).toBeInstanceOf(cause);
  expect(exitCodeForError(err)).toBe(64);
}

test("an inbound message over the frame cap exits 64 through the bridge", async () => {
  const { bridge } = await rendezvous();
  fs.writeFileSync(path.join(dropDir, `${B}-999999999999.json`), "x");
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /exceeding the maximum inbound frame size/);
  expect((err as Error).cause?.constructor.name).toBe("FrameSizeExceededError");
});

test("a directory listing over its bounds exits 64 through the bridge", async () => {
  const { client, bridge } = await rendezvous();
  client.listFault = () => directoryTooLargeError(dropDir, 8192);
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /more than 8192 entries/);
  expect((err as Error).cause?.constructor.name).toBe(
    "DirectoryListingBoundsError",
  );
});

test("a stalled transport operation exits 64 through the bridge", async () => {
  const { client, bridge } = await rendezvous();
  client.listFault = () => listingStalledByTimeoutError(dropDir, 60_000);
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /stalled/);
  expect((err as Error).cause?.constructor.name).toBe(
    "TransportOperationStalledError",
  );
});

test("a spent SFTP reconnect budget exits 64 through the bridge", async () => {
  const { client, bridge } = await rendezvous();
  client.listFault = () => midExchangeReconnectBudgetExhaustedError(2, 1);
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /reconnection budget is exhausted/);
});

test("an unexpected file mid-exchange exits 64 through the bridge", async () => {
  const { bridge } = await rendezvous();
  fs.writeFileSync(path.join(dropDir, "stray.txt"), "not part of the exchange");
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /unexpected file\(s\) appeared/);
});

test("a corrupt partner message exits 64 through the bridge", async () => {
  const { bridge } = await rendezvous();
  fs.writeFileSync(path.join(dropDir, `${B}-5.json`), "xxxxx");
  const err = await rejection(bridge.receive());
  expectBridgedUsageExit(err, /malformed envelope/);
});

test("a message the partner never consumes exits 64 through the bridge", async () => {
  const { bridge } = await rendezvous(1_500);
  await bridge.send({ n: 1 });
  const err = await rejection(bridge.send({ n: 2 }));
  expectBridgedUsageExit(
    err,
    /timed out waiting for message from party-a to be consumed/,
  );
}, 20_000);

test("a send on a spent sequence number exits 64 through the bridge", async () => {
  // The publish the transport could not confirm fails the first bridge, as a
  // transport fault of its own; a later send on the same connection is the
  // refusal under test, reached here through a second bridge.
  const { client, connA, bridge } = await rendezvous();
  client.renameFault = (toPath) =>
    path.basename(toPath).startsWith(`${A}-`) && toPath.endsWith(".json")
      ? new TransportPublishIndeterminateError(
          "the rename outcome is unknown",
          {
            cause: new Error("connection reset during rename"),
          },
        )
      : undefined;
  const first = await rejection(bridge.send({ n: 1 }));
  expect(exitCodeForError(first)).toBe(69);
  client.renameFault = undefined;
  const err = await rejection(fromEventConnection(connA).send({ n: 2 }));
  expectBridgedUsageExit(
    err,
    /was spent on a publish the transport could not confirm/,
  );
});
