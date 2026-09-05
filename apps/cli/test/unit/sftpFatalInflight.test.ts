import fsp from "node:fs/promises";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { MAX_FILENAME_LENGTH } from "../../src/connection/listingGuard";
import { startInProcessSftpServer } from "../sftpServer/inProcessServer";
import { serverAuth } from "../sftpServer/testContext";
import type { InProcessSftpServer } from "../sftpServer/types";

// In-process fault-injection harness for the malformed-in-flight-reply path.
//
// What this proves, that the mock-driven adapter tests cannot: when a hostile server
// sends a malformed reply to the in-flight request itself, ssh2's NAME/DATA handlers
// delete the request from `_requests` before the malformed-packet check that calls
// doFatalSFTPError runs, so cleanupRequests has nothing left to fail for that reqid.
// The in-flight list()/get() is bounded only by the adapter's own deadline, never by
// cleanupRequests (see ssh2SftpAdapter.ts and docs/spec/CHANNEL_SECURITY.md).
//
// The same in-process ssh2 server the conformance suite runs against backs this test
// through its fault hooks (a malformed NAME reply to READDIR, a malformed DATA reply
// to READ, or an over-length NAME batch) -- one in-process server, not two. This
// test stands up its own instance because the fault hooks need the server in the
// same worker as the adapter, out of reach of the conformance suite's globalSetup
// server. The malformed bytes still ride ssh2's real protocol/stream boundary.

const NS = "fatal";

async function connectAdapter(
  srv: InProcessSftpServer,
  stallDeadlineMs?: number,
): Promise<SSH2SFTPClientAdapter> {
  const adapter =
    stallDeadlineMs === undefined
      ? new SSH2SFTPClientAdapter()
      : // Internal-only test hook: shortens the per-op liveness deadline so the
        // "ultimately bounded" half of the proof runs in milliseconds rather than
        // the real 60 s. It is a non-configurable options field, never wired to
        // any config or CLI surface, so production keeps the fixed bound.
        new SSH2SFTPClientAdapter({ stallDeadlineMs });
  await adapter.connect({
    host: srv.handle.host,
    port: srv.handle.port,
    ...serverAuth(srv.handle.usera),
    maxReconnectAttempts: 0,
  });
  return adapter;
}

// Track a promise's settlement without awaiting it, so the test can assert it is
// still pending after a short window.
function track<T>(p: Promise<T>): { settled: () => boolean } {
  let done = false;
  // Swallow rejection here so a later rejection (after the deadline) is not an
  // unhandled rejection; the test inspects `settled()` for promptness only.
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("malformed in-flight SFTP reply", () => {
  let srv: InProcessSftpServer;
  let backingNamespace: string;
  let adapters: SSH2SFTPClientAdapter[];

  beforeAll(async () => {
    srv = await startInProcessSftpServer();
    backingNamespace = path.join(srv.handle.backingDir, NS);
    await fsp.mkdir(backingNamespace, { recursive: true });
  });

  afterAll(async () => {
    await srv.stop();
  });

  beforeEach(() => {
    adapters = [];
    // Reset every fault field, not just the ones this suite drives today, so a
    // later test setting withholdOn/renameFailuresRemaining/readdirBatchSize
    // cannot leak into the next test on the shared server instance.
    srv.inject.malformedNameOnNextReaddir = false;
    srv.inject.malformedDataOnNextRead = false;
    srv.inject.oversizeNameOnNextReaddir = null;
    srv.inject.nameReplyFilenameBytesOnNextReaddir = null;
    srv.inject.withholdOn = null;
    srv.inject.renameFailuresRemaining = 0;
    srv.inject.readdirBatchSize = 0;
  });

  afterEach(async () => {
    await Promise.all(adapters.map((a) => a.end().catch(() => {})));
  });

  const remote = (suffix = ""): string =>
    `${srv.handle.remoteRoot}/${NS}${suffix}`;

  test("does not crash and does not settle the in-flight list() promptly", async () => {
    // (a) the malformed in-flight reply does not crash the process -- reaching the
    // assertions below is itself part of that proof. (b) the in-flight list() is not
    // settled promptly: cleanupRequests cannot fail it (ssh2 already deleted the
    // request), so it stays pending after a short window. No deadline hook here, so
    // the real 60 s bound applies and the operation hangs for the window.
    const adapter = await connectAdapter(srv);
    adapters.push(adapter);

    srv.inject.malformedNameOnNextReaddir = true;
    const tracked = track(adapter.list(remote()));
    await delay(300);
    expect(tracked.settled()).toBe(false);
  });

  test("does not crash and does not settle the in-flight get() promptly", async () => {
    // Same proof on the read path: a malformed DATA reply to the in-flight READ
    // is not failed by cleanupRequests, so get() stays pending.
    await fsp.writeFile(path.join(backingNamespace, "file"), Buffer.alloc(8));
    const adapter = await connectAdapter(srv);
    adapters.push(adapter);

    srv.inject.malformedDataOnNextRead = true;
    const tracked = track(adapter.get(remote("/file"), { maxBytes: 64 }));
    await delay(300);
    expect(tracked.settled()).toBe(false);
  });

  test("is ultimately bounded: the deadline settles the in-flight list() terminally", async () => {
    // Completes the proof: the wall-clock deadline still bounds the hung operation,
    // raising the typed terminal TransportOperationStalledError (a UsageError).
    // Driven through the internal deadline hook (150 ms here) so the bound fires
    // fast; production uses the fixed 60 s. Together with the real-server hang
    // above, this shows the deadline -- not cleanupRequests -- is what ends it;
    // ssh2SftpAdapter.test.ts's fake-timer tests cover the deadline-logic details.
    const adapter = await connectAdapter(srv, 150);
    adapters.push(adapter);

    srv.inject.malformedNameOnNextReaddir = true;
    const err = await adapter.list(remote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportOperationStalledError);
    expect(err).toBeInstanceOf(UsageError);
  });

  test("rejects a valid NAME batch whose filename exceeds the length bound", async () => {
    // The filename-length directory-listing bound, real-exercised: a real ssh2
    // Server returns a WELL-FORMED NAME packet whose filename exceeds
    // MAX_FILENAME_LENGTH, and list() must refuse it with the typed
    // DirectoryListingBoundsError over real wire bytes, not the mocked readdir in
    // ssh2SftpAdapter.test.ts. (The entry-count bound stays on that mock test --
    // crossing its 8,192-entry cap needs multi-packet batching, not worth it here.)
    const adapter = await connectAdapter(srv);
    adapters.push(adapter);

    srv.inject.oversizeNameOnNextReaddir = "x".repeat(MAX_FILENAME_LENGTH + 1);
    const err = await adapter.list(remote()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryListingBoundsError);
  });
});
