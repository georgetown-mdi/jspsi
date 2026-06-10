import { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DirectoryListingBoundsError,
  TransportOperationStalledError,
  UsageError,
} from "@psilink/core";
import ssh2 from "ssh2";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { MAX_FILENAME_LENGTH } from "../../src/connection/listingGuard";

const { Server, utils } = ssh2;

// In-process fault-injection harness for the malformed-in-flight-reply path.
//
// What this proves, that the mock-driven adapter tests cannot: when a hostile
// server returns a MALFORMED reply to the in-flight request ITSELF, the
// in-flight list()/get() is bounded by the adapter's wall-clock deadline, NOT by
// ssh2's cleanupRequests. ssh2's NAME/DATA handlers delete the request from
// `_requests` before the malformed-packet check that calls doFatalSFTPError, so
// by the time cleanupRequests runs there is nothing left to fail for that reqid
// and the in-flight callback never fires (see ssh2SftpAdapter.ts and
// docs/SECURITY_DESIGN.md "Channel security"). This disproves the old claim that
// cleanupRequests rejects an in-flight read immediately, and pins the corrected
// mechanism against a real wire packet rather than source-reading.
//
// The harness stands up a real ssh2 Server on loopback (its own ephemeral host
// key -- no Docker atmoz/sftp container needed), accepts the session/sftp
// subsystem, answers OPENDIR/OPEN with a handle, then on the in-flight
// READDIR/READ writes RAW malformed bytes carrying that request's id straight to
// the channel. ssh2's public name()/data() server APIs only ever emit valid
// packets, so the malformed bytes are written through ssh2's internal
// protocol/stream seam (`sftp._protocol.channelData(sftp.outgoing.id, ...)`),
// which is what a real malformed server would put on the wire.

const RESPONSE_NAME = 104;
const RESPONSE_DATA = 103;

// Frame an SFTP packet: [length u32][type u8][reqid u32][...body].
function frame(type: number, reqid: number, body: Buffer): Buffer {
  const payload = Buffer.alloc(1 + 4 + body.length);
  payload[0] = type;
  payload.writeUInt32BE(reqid, 1);
  body.copy(payload, 5);
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

// A NAME packet that claims one entry (count = 1) but supplies no filename
// bytes, so ssh2's parser reads the filename as undefined and falls into
// doFatalSFTPError('Malformed NAME packet').
function malformedNamePacket(reqid: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(1, 0); // count = 1, then truncated
  return frame(RESPONSE_NAME, reqid, body);
}

// A DATA packet whose declared string length (0xffffffff) overruns the buffer,
// so ssh2's parser returns undefined and falls into
// doFatalSFTPError('Malformed DATA packet').
function malformedDataPacket(reqid: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(0xffffffff, 0); // bogus data length
  return frame(RESPONSE_DATA, reqid, body);
}

// The internal seam used to write raw bytes onto the SFTP channel. The public
// server API will not emit a malformed packet, so the test reaches past it the
// same way the spike that found this did.
interface RawChannelSftp {
  _protocol: { channelData(id: unknown, data: Buffer): void };
  outgoing: { id: unknown };
}

// "readdir"/"read" inject a malformed reply to the in-flight request; the
// "oversizeName" mode instead returns a VALID (well-formed) NAME batch whose one
// filename exceeds MAX_FILENAME_LENGTH, so list() reaches its directory-listing
// bound against real wire bytes rather than a mocked readdir.
type InflightKind = "readdir" | "read" | "oversizeName";

// Start a server that answers the directory-open/file-open with a handle and
// then either injects a malformed reply to the first in-flight READDIR (for
// list()) or READ (for get()), or serves a valid-but-over-bound NAME batch.
// Returns the listening port and a closer.
async function startMalformedServer(kind: InflightKind): Promise<{
  port: number;
  close: () => void;
}> {
  // ECDSA, not ed25519: ssh2's generateKeyPairSync intermittently emits an
  // ed25519 OpenSSH private key it cannot parse back ("Malformed OpenSSH private
  // key", ~0.2-0.3% per Server construction), and this harness builds a server
  // several times per run, so an ed25519 key would flake in CI. The key type is
  // irrelevant to what the test exercises (the malformed-reply injection); ecdsa
  // is fast and has not reproduced the parse fault.
  const hostKey = utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          let handleSeq = 0;
          const giveHandle = (reqid: number): void => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++handleSeq, 0);
            sftp.handle(reqid, handle);
          };
          const injectRaw = (packet: Buffer): void => {
            const raw = sftp as unknown as RawChannelSftp;
            raw._protocol.channelData(raw.outgoing.id, packet);
          };
          sftp.on("OPENDIR", (reqid) => giveHandle(reqid));
          sftp.on("OPEN", (reqid) => giveHandle(reqid));
          // get() issues an FSTAT before READ to size the transfer; answer it
          // with a small size so the library proceeds to the READ we corrupt.
          sftp.on("FSTAT", (reqid) => {
            sftp.attrs(reqid, { size: 8, mode: 0o100644 });
          });
          // For "oversizeName", READDIR is answered once with a valid NAME
          // batch carrying an over-length filename, then with EOF; the batch
          // delivery is tracked so the second READDIR returns EOF.
          let oversizeServed = false;
          sftp.on("READDIR", (reqid) => {
            if (kind === "readdir") {
              injectRaw(malformedNamePacket(reqid));
            } else if (kind === "oversizeName" && !oversizeServed) {
              oversizeServed = true;
              const filename = "x".repeat(MAX_FILENAME_LENGTH + 1);
              sftp.name(reqid, [
                {
                  filename,
                  longname: filename,
                  attrs: {
                    mode: 0o100644,
                    uid: 0,
                    gid: 0,
                    size: 0,
                    atime: 0,
                    mtime: 0,
                  },
                },
              ]);
            } else {
              sftp.status(reqid, utils.sftp.STATUS_CODE.EOF);
            }
          });
          sftp.on("READ", (reqid) => {
            if (kind === "read") injectRaw(malformedDataPacket(reqid));
            else sftp.status(reqid, utils.sftp.STATUS_CODE.EOF);
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

async function connectAdapter(
  port: number,
  stallDeadlineMs?: number,
): Promise<SSH2SFTPClientAdapter> {
  const adapter =
    stallDeadlineMs === undefined
      ? new SSH2SFTPClientAdapter()
      : // Internal-only test seam: shortens the per-op liveness deadline so the
        // "ultimately bounded" half of the proof runs in milliseconds rather than
        // the real 60 s. It is a non-configurable options field, never wired to
        // any config or CLI surface, so production keeps the fixed bound.
        new SSH2SFTPClientAdapter({ stallDeadlineMs });
  await adapter.connect({
    host: "127.0.0.1",
    port,
    username: "u",
    password: "p",
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
  let servers: Array<() => void>;
  let adapters: SSH2SFTPClientAdapter[];

  beforeEach(() => {
    servers = [];
    adapters = [];
  });

  afterEach(async () => {
    await Promise.all(adapters.map((a) => a.end().catch(() => {})));
    for (const close of servers) close();
  });

  test("does not crash and does not settle the in-flight list() promptly", async () => {
    // (a) the malformed in-flight reply does not crash the process -- reaching
    // the assertions below is itself part of that proof. (b) the in-flight
    // list() is NOT settled promptly: cleanupRequests cannot fail it (ssh2
    // already deleted the request), so it is still pending after a short window.
    // This is the assertion that disproves the old "rejects immediately via
    // cleanupRequests" claim. No deadline seam here, so the real 60 s bound is
    // untouched and the operation genuinely hangs for the window.
    const { port, close } = await startMalformedServer("readdir");
    servers.push(close);
    const adapter = await connectAdapter(port);
    adapters.push(adapter);

    const tracked = track(adapter.list("/dir"));
    await delay(300);
    expect(tracked.settled()).toBe(false);
  });

  test("does not crash and does not settle the in-flight get() promptly", async () => {
    // Same proof on the read path: a malformed DATA reply to the in-flight READ
    // is not failed by cleanupRequests, so get() stays pending.
    const { port, close } = await startMalformedServer("read");
    servers.push(close);
    const adapter = await connectAdapter(port);
    adapters.push(adapter);

    const tracked = track(adapter.get("/dir/file", { maxBytes: 64 }));
    await delay(300);
    expect(tracked.settled()).toBe(false);
  });

  test("is ultimately bounded: the deadline settles the in-flight list() terminally", async () => {
    // Completes the proof: the operation is hung by the malformed reply but the
    // wall-clock deadline still bounds it, surfacing the typed terminal
    // TransportOperationStalledError (a UsageError). Driven through the internal
    // deadline seam (150 ms here) so the bound fires fast; the production bound is
    // the fixed 60 s. Decomposition note: the real server proves the in-flight op
    // hangs past cleanupRequests (above) and that the deadline -- not
    // cleanupRequests -- is what ends it (here); the existing fake-timer adapter
    // tests in ssh2SftpAdapter.test.ts cover the deadline-logic details.
    const { port, close } = await startMalformedServer("readdir");
    servers.push(close);
    const adapter = await connectAdapter(port, 150);
    adapters.push(adapter);

    const err = await adapter.list("/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportOperationStalledError);
    expect(err).toBeInstanceOf(UsageError);
  });

  test("rejects a valid NAME batch whose filename exceeds the length bound", async () => {
    // The filename-length directory-listing bound, real-exercised: a real ssh2
    // Server returns a WELL-FORMED NAME packet (via the public name() API) whose
    // one filename is longer than MAX_FILENAME_LENGTH. list() must refuse it with
    // the typed DirectoryListingBoundsError over real wire bytes, not just the
    // mocked readdir in ssh2SftpAdapter.test.ts. (The entry-count bound is left to
    // that mock test: it bites at the fixed 8,192-entry cap, which is not
    // test-lowerable and would need multi-packet batching to cross on the wire --
    // heavier and not worth the flakiness for a bound the mock already pins.)
    const { port, close } = await startMalformedServer("oversizeName");
    servers.push(close);
    const adapter = await connectAdapter(port);
    adapters.push(adapter);

    const err = await adapter.list("/dir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryListingBoundsError);
  });
});
