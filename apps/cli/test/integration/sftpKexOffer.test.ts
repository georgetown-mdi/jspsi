import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import ssh2 from "ssh2";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  inject,
  test,
  vi,
} from "vitest";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  selectedBackend,
  selectedNativeProfile,
  startInProcessSftpServer,
} from "../sftpServer";
import { serverAuth } from "../sftpServer/testContext";
import {
  APPENDED_MARKERS,
  createKexinitRecordingRelay,
  decodeOfferedKexAlgorithms,
} from "./kexOfferWire";
import type { KexPrimitive } from "../../src/connection/sftpKexCapability";
import { inProcessOnly } from "../sftpBackendGate";

// What the SFTP client actually OFFERS, read off the wire from the client's own
// SSH_MSG_KEXINIT, with the platform-capability verdict forced to "this process
// cannot perform X25519".
//
// The unit suite pins the OPTIONS the constraint produces; only the installed
// ssh2 can say what those options mean, and every claim about that is settled by
// driving it here rather than by reading its source (CLAUDE.md). Nothing below
// predicts ssh2's behaviour: each listener answers the SSH identification string
// and then decodes the one unencrypted packet ssh2 sends, so what is asserted is
// the byte sequence ssh2 put on the socket. The dials that have to complete a
// handshake -- the host-key probe and the recovery re-dial -- read the same
// packet from a relay in front of the suite's real server.
//
// Why the verdict is forced rather than produced by a FIPS host: the only lever
// available in this image is `crypto.setFips(true)`, and it is NOT a model of a
// FIPS host. Measured on this image (node 26.5.1 / openssl 3.5.7), it leaves
// OpenSSL with no usable algorithms at all -- `createHash("sha256")`,
// `createCipheriv("aes-128-gcm", ...)` and `generateKeyPairSync("ec",
// {namedCurve: "prime256v1"})` all throw
// `error:0308010C:digital envelope routines::unsupported`, so a handshake it
// "fixed" would still die at the first hash. A real FIPS provider keeps those and
// drops only X25519, which is what the forced verdict below models.

const forcedMissingPrimitive: KexPrimitive = {
  primitive: "X25519",
  matchesAlgorithm: /25519/i,
  perform: () => {
    throw new Error("error:0308010C:digital envelope routines::unsupported");
  },
};

// Only the host VERDICT is replaced; the constraint itself, the adapter, and ssh2
// are the real ones. This is the seam that lets the adapter's own dial path be
// driven on a host that can perform X25519 perfectly well.
vi.mock("../../src/connection/sftpKexCapability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/connection/sftpKexCapability")
    >();
  return {
    ...actual,
    unavailableKexPrimitives: () => [forcedMissingPrimitive],
  };
});

const { SSH2SFTPClientAdapter } =
  await import("../../src/connection/ssh2SftpAdapter");
const { probeHostKeyLines } = await import("../../src/commands/probeHostKey");

const SSH_MSG_DISCONNECT = 1;
const SSH_DISCONNECT_PROTOCOL_ERROR = 2;

// Only the in-process backend can be told to cut a session mid-operation (see
// test/sftpServer/types.ts), which is what the recovery re-dial needs.

// The native harness's restricted-crypto profile accepts only curve25519 key
// exchanges (test/sftpServer/nativeSshdServer.ts), so under the forced verdict
// above there is nothing both ends can perform. That is not a failure of the
// constraint but the permanent incompatibility it exists to name, which the last
// describe drives on purpose against a server of its own. A dial that has to
// COMPLETE therefore needs a server offering something this process can perform.
const serverOffersAPerformableKex = test.skipIf(
  selectedBackend() === "native" &&
    selectedNativeProfile() === "restricted-crypto",
);

// The other side of that skip: on exactly that profile the suite's server is a
// real OpenSSH sshd accepting only what the forced verdict withholds, which is
// the deployment the fast-fail below exists for and the only one in the tree
// where a native sshd refuses the whole offer.
const serverOffersNoPerformableKex = test.skipIf(
  !(
    selectedBackend() === "native" &&
    selectedNativeProfile() === "restricted-crypto"
  ),
);

// A transfer long enough that the cut below lands inside the READ run rather than
// at its edges, and the re-dial's budget for the read that follows it.
const TRANSFER_BYTES = 512 * 1024;
const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * A listener that speaks just enough SSH to make a client send its KEXINIT --
 * the identification string -- then decodes that packet and hands back the
 * key-exchange algorithms the client offered. The first binary packet of an SSH
 * connection is unencrypted, so no key material is involved.
 */
function createKexinitReader(): {
  port: Promise<number>;
  offered: Promise<string[]>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  let resolveOffered!: (algorithms: string[]) => void;
  let rejectOffered!: (err: unknown) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const offered = new Promise<string[]>((resolve, reject) => {
    resolveOffered = resolve;
    rejectOffered = reject;
  });

  const server = net.createServer((socket) => {
    socket.write("SSH-2.0-psilink-kexinit-reader\r\n");
    let buffered = Buffer.alloc(0);
    let identificationConsumed = false;
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!identificationConsumed) {
        const end = buffered.indexOf("\n");
        if (end === -1) return;
        buffered = buffered.subarray(end + 1);
        identificationConsumed = true;
      }
      if (buffered.length < 4) return;
      const packetLength = buffered.readUInt32BE(0);
      if (buffered.length < 4 + packetLength) return;
      const paddingLength = buffered.readUInt8(4);
      try {
        resolveOffered(
          decodeOfferedKexAlgorithms(
            buffered.subarray(5, 4 + packetLength - paddingLength),
          ),
        );
      } catch (err) {
        rejectOffered(err);
      }
      socket.destroy();
    });
    // The client tears this down as soon as the handshake fails; that is the
    // point, and it must not reach the process as an unhandled error.
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, offered, close: () => server.close() };
}

/**
 * A listener that answers the identification string and then sends one
 * `SSH_MSG_DISCONNECT` carrying a description of the caller's choosing -- the
 * server-controlled text ssh2 renders into its `Client` error message. Written
 * on the wire rather than through ssh2's `Server`, which offers no seam for the
 * description.
 */
function createDisconnectingServer(description: string): {
  port: Promise<number>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const uint32 = (value: number): Buffer => {
    const encoded = Buffer.alloc(4);
    encoded.writeUInt32BE(value);
    return encoded;
  };
  const server = net.createServer((socket) => {
    socket.write("SSH-2.0-psilink-disconnecting-listener\r\n");
    socket.once("data", () => {
      const reason = Buffer.from(description, "utf8");
      const payload = Buffer.concat([
        Buffer.from([SSH_MSG_DISCONNECT]),
        uint32(SSH_DISCONNECT_PROTOCOL_ERROR),
        uint32(reason.length),
        reason,
        uint32(0), // language tag
      ]);
      // RFC 4253 6: length field, padding length, payload and padding total a
      // multiple of 8, with at least 4 bytes of padding.
      const block = 8 - ((payload.length + 5) % 8);
      const padding = Buffer.alloc(block < 4 ? block + 8 : block);
      socket.write(
        Buffer.concat([
          uint32(payload.length + padding.length + 1),
          Buffer.from([padding.length]),
          payload,
          padding,
        ]),
      );
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, close: () => server.close() };
}

// One dial's worth of connect options: no retries, so a listener that never
// completes a handshake costs one attempt rather than the default budget.
const dialOptions = (
  port: number,
  algorithms?: Record<string, unknown>,
): Record<string, unknown> => ({
  host: "127.0.0.1",
  port,
  username: "probe",
  password: "probe",
  readyTimeout: 5_000,
  maxReconnectAttempts: 0,
  ...(algorithms === undefined ? {} : { algorithms }),
});

async function offeredByAdapter(
  algorithms?: Record<string, unknown>,
): Promise<string[]> {
  const reader = createKexinitReader();
  const adapter = new SSH2SFTPClientAdapter();
  try {
    const port = await reader.port;
    await adapter.connect(dialOptions(port, algorithms)).catch(() => {});
    return await reader.offered;
  } finally {
    await adapter.end().catch(() => {});
    reader.close();
  }
}

async function offeredByBareSsh2(
  algorithms?: Record<string, unknown>,
): Promise<string[]> {
  const reader = createKexinitReader();
  try {
    const port = await reader.port;
    const client = new ssh2.Client();
    client.on("error", () => {});
    client.connect({
      host: "127.0.0.1",
      port,
      username: "probe",
      password: "probe",
      readyTimeout: 5_000,
      ...(algorithms === undefined
        ? {}
        : { algorithms: algorithms as ssh2.Algorithms }),
    });
    const offered = await reader.offered;
    client.end();
    return offered;
  } finally {
    reader.close();
  }
}

describe("the key-exchange offer on the wire", () => {
  let bare: string[];
  let constrained: string[];

  beforeAll(async () => {
    bare = await offeredByBareSsh2();
    constrained = await offeredByAdapter();
  });

  test("ssh2 on its own offers X25519 whatever the platform can perform", () => {
    // The defect: ssh2 builds this list at module load and never probes, so the
    // constraint has something real to subtract.
    expect(bare.some((name) => /25519/i.test(name))).toBe(true);
  });

  test("the adapter withholds every X25519 algorithm", () => {
    expect(constrained.filter((name) => /25519/i.test(name))).toEqual([]);
  });

  test("the adapter still offers algorithms the server can choose from", () => {
    // An empty offer would be the same handshake death by another route, and it
    // is reachable by accident: ssh2 reads an empty explicit list as
    // "unspecified" and falls back to its defaults. The subtraction leaves
    // ssh2's approved remainder standing.
    const negotiable = constrained.filter(
      (name) => name !== "ext-info-c" && !name.startsWith("kex-strict-"),
    );
    expect(negotiable.length).toBeGreaterThan(0);
    expect(negotiable).toContain("ecdh-sha2-nistp256");
  });

  test("the appended markers survive the constraint", () => {
    // ssh2 appends these to whatever list is offered, outside the filtering the
    // constraint reaches. The shapes an operator's own algorithms.kex takes are
    // driven in the describe below.
    for (const marker of APPENDED_MARKERS) {
      expect(bare).toContain(marker);
      expect(constrained).toContain(marker);
    }
  });

  test("the constraint subtracts from ssh2's offer and adds nothing to it", () => {
    // psilink owns the subtraction; ssh2 keeps ownership of which algorithms
    // exist and in what order. Anything the adapter offered that ssh2 would not
    // have would be psilink choosing a key-exchange algorithm.
    expect(constrained.every((name) => bare.includes(name))).toBe(true);
    expect(constrained).toEqual(bare.filter((name) => !/25519/i.test(name)));
  });
});

describe("the offer shapes an operator's own algorithms.kex takes", () => {
  // The describe above drives the default shape -- no operator algorithms.kex at
  // all. The other two shapes the constraint accepts reach ssh2 as a filtered
  // list and as a merged modifier, and each has to arrive on the wire withholding
  // X25519 while still carrying what ssh2 appends outside its filtering.

  test("an explicit list is offered filtered, markers and all", async () => {
    const [offered, logs] = await withCapturedLogs(() =>
      offeredByAdapter({
        kex: [
          "curve25519-sha256",
          "ecdh-sha2-nistp256",
          "diffie-hellman-group14-sha256",
        ],
      }),
    );
    expect(offered).toEqual([
      "ecdh-sha2-nistp256",
      "diffie-hellman-group14-sha256",
      ...APPENDED_MARKERS,
    ]);
    expect(logs.map((entry) => entry.message).join("\n")).toContain("X25519");
  });

  test("a modifier's own append cannot re-add what the constraint removed", async () => {
    // ssh2 applies `remove` after `append`/`prepend` -- the premise merging the
    // constraint's removal into an operator's modifier rests on, and the reason
    // an operator cannot put an unperformable algorithm back by naming it.
    const offered = await offeredByAdapter({
      kex: {
        append: ["curve25519-sha256"],
        prepend: ["curve25519-sha256@libssh.org"],
      },
    });
    expect(offered.filter((name) => /25519/i.test(name))).toEqual([]);
    expect(offered).toContain("ecdh-sha2-nistp256");
    for (const marker of APPENDED_MARKERS) expect(offered).toContain(marker);
  });

  test("a list that arrives empty offers the defaults minus X25519", async () => {
    // An empty list names nothing to drop, so the filter has nothing to refuse --
    // and forwarding it would restore ssh2's full defaults (driven below).
    const [offered, logs] = await withCapturedLogs(() =>
      offeredByAdapter({ kex: [] }),
    );
    expect(offered.filter((name) => /25519/i.test(name))).toEqual([]);
    expect(offered).toContain("ecdh-sha2-nistp256");
    for (const marker of APPENDED_MARKERS) expect(offered).toContain(marker);
    expect(logs.map((entry) => entry.message).join("\n")).toContain(
      "connection.provider_options.algorithms.kex",
    );
  });
});

describe("what ssh2 makes of a kex value psilink must not forward", () => {
  // The measured ssh2 behaviour the refusal and the empty-list replacement exist
  // for: these values are read as *unspecified* and restore the full defaults,
  // X25519 included. Driven against bare ssh2 because the constraint's whole job
  // is that they never reach it from psilink.
  let bare: string[];

  beforeAll(async () => {
    bare = await offeredByBareSsh2();
  });

  test("an empty explicit list restores every default, X25519 included", async () => {
    const offered = await offeredByBareSsh2({ kex: [] });
    expect(offered).toEqual(bare);
    expect(offered.some((name) => /25519/i.test(name))).toBe(true);
  });

  test("a value that is neither a list nor a modifier is inert", async () => {
    expect(await offeredByBareSsh2({ kex: "ecdh-sha2-nistp256" })).toEqual(
      bare,
    );
    expect(await offeredByBareSsh2({ kex: null })).toEqual(bare);
  });
});

describe("the constrained offer against a real SFTP server", () => {
  serverOffersAPerformableKex(
    "negotiates and connects with no operator configuration",
    async () => {
      // The whole point of the constraint: on a host missing X25519 the default
      // case must just work. The suite's server offers X25519 FIRST -- so an
      // unconstrained client would win the negotiation with it and die -- and the
      // approved remainder behind it, which is what this dial lands on.
      const server = inject("sftpServer");
      const adapter = new SSH2SFTPClientAdapter();
      // The pin serverAuth carries belongs to a connection's `server` block
      // rather than to ssh2's own options, so it stays out of the dial.
      const { hostKeyFingerprint, ...auth } = serverAuth(server.usera);
      try {
        await adapter.connect({
          host: server.host,
          port: server.port,
          ...auth,
          readyTimeout: 5_000,
          maxReconnectAttempts: 0,
        });
        expect(await adapter.list(server.remoteRoot)).toBeInstanceOf(Array);
      } finally {
        await adapter.end().catch(() => {});
      }
    },
  );

  serverOffersAPerformableKex(
    "the host-key probe dials constrained and still reads the key",
    async () => {
      // The probe is one of the dial paths the constraint sits at connectLocked to
      // cover, and it reaches the wire through core rather than through a direct
      // adapter.connect(). Reading the server's real fingerprint through the relay
      // is what says the constrained offer negotiated as far as host-key
      // presentation, not merely that the offer was constrained.
      const server = inject("sftpServer");
      const relay = createKexinitRecordingRelay(server);
      try {
        const result = await probeHostKeyLines({
          sftpUrl: `sftp://127.0.0.1:${await relay.port}`,
          connectTimeoutSeconds: 10,
          json: true,
          verbosity: -1,
        });
        const parsed = JSON.parse(result.stdout ?? "{}") as {
          fingerprint: string;
        };
        expect(parsed.fingerprint).toBe(server.hostKeyFingerprint);
        expect(relay.offers).toHaveLength(1);
        expect(relay.offers[0]!.filter((name) => /25519/i.test(name))).toEqual(
          [],
        );
        for (const marker of APPENDED_MARKERS)
          expect(relay.offers[0]).toContain(marker);
      } finally {
        await relay.close();
      }
    },
  );

  inProcessOnly(
    "the recovery re-dial offers exactly what the first dial offered",
    async () => {
      // The other dial path at connectLocked: a re-dial entered with the RETAINED
      // options, which are already constrained. Constraining them again has to be
      // a no-op -- a compounded or dropped constraint would show up as a second
      // offer differing from the first. The unit suite pins that in memory; this
      // is the pair of offers on the wire, from a session the server really cut.
      const srv = await startInProcessSftpServer();
      const relay = createKexinitRecordingRelay(srv.handle);
      const adapter = new SSH2SFTPClientAdapter();
      const dir = await fsp.mkdtemp(path.join(srv.handle.backingDir, "kex-"));
      await fsp.writeFile(
        path.join(dir, "transfer.bin"),
        Buffer.alloc(TRANSFER_BYTES, 7),
      );
      try {
        await adapter.connect({
          host: "127.0.0.1",
          port: await relay.port,
          username: srv.handle.usera.username,
          password: srv.handle.usera.password,
          readyTimeout: 5_000,
          maxReconnectAttempts: 2,
        });
        const [read] = await withCapturedLogs(
          async () => {
            // Cut the session inside the read the adapter is running, which is what
            // sends it through the recovery re-dial.
            srv.sessionControls.dropActiveAfterOps(3);
            return adapter.get(
              `${srv.handle.remoteRoot}/${path.basename(dir)}/transfer.bin`,
              { maxBytes: 4 * TRANSFER_BYTES },
            );
          },
          (level) => level === "WARN" || level === "ERROR",
        );
        expect(read).toHaveLength(TRANSFER_BYTES);
        expect(adapter.midExchangeReconnectCount).toBe(1);

        expect(relay.offers).toHaveLength(2);
        for (const offer of relay.offers) {
          expect(offer.filter((name) => /25519/i.test(name))).toEqual([]);
          for (const marker of APPENDED_MARKERS)
            expect(offer).toContain(marker);
        }
        expect(relay.offers[1]).toEqual(relay.offers[0]);
      } finally {
        srv.sessionControls.dropActiveAfterOps(0);
        await adapter.end().catch(() => {});
        await relay.close();
        await fsp.rm(dir, { recursive: true, force: true });
        await srv.stop();
      }
    },
    RECOVERY_TIMEOUT_MS,
  );
});

describe("a server that accepts only algorithms this process cannot perform", () => {
  // The permanent incompatibility class: the client's whole offer is refused
  // because every algorithm the server accepts needs the missing primitive.
  const { Server, utils } = ssh2;
  let server: ssh2.Server;
  let port: number;

  beforeAll(async () => {
    server = new Server(
      {
        hostKeys: [utils.generateKeyPairSync("ecdsa", { bits: 256 }).private],
        algorithms: { kex: ["curve25519-sha256"] },
      },
      (client) => {
        client.on("error", () => {});
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("the dial fails naming the platform capability, not the server", async () => {
    const adapter = new SSH2SFTPClientAdapter();
    let thrown: unknown;
    try {
      await adapter.connect(dialOptions(port));
    } catch (err) {
      thrown = err;
    } finally {
      await adapter.end().catch(() => {});
    }
    const error = thrown as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("X25519");
    expect(error.message).toContain("server's administrator");
    // ssh2's own account of the failure is kept, one cause link down.
    expect((error.cause as Error).message).toContain(
      "no matching key exchange algorithm",
    );
  });

  test("the dial ends at the first refusal, spending no reconnect budget", async () => {
    // The incompatibility lasts the life of the process, so the connect loop
    // must not re-dial it once a second for the whole reconnect budget. Driven
    // with a budget of 3 through the relay, which counts the dials: the
    // rejection arrives only once the loop is finished with them, so a retried
    // dial is a second accepted connection here, not a slower test.
    const relay = createKexinitRecordingRelay({ host: "127.0.0.1", port });
    const adapter = new SSH2SFTPClientAdapter();
    try {
      await expect(
        adapter.connect({
          ...dialOptions(await relay.port),
          maxReconnectAttempts: 3,
        }),
      ).rejects.toThrow("X25519");
      expect(relay.accepted()).toBe(1);
    } finally {
      await adapter.end().catch(() => {});
      await relay.close();
    }
  });

  test("a server that writes the failure message itself supplies no byte of the diagnostic", async () => {
    // The message fragment the diagnostic keys on is inside ssh2's rendering of
    // the server's own SSH_MSG_DISCONNECT description, so a server writes it
    // verbatim -- and reaches the same diagnostic anyway by restricting its offer
    // as the case above does, with no message control at all. What the match must
    // not do is let the server's bytes into psilink's own advice: the top-level
    // message is composed from constants, and the server's text stays one cause
    // link down, where the display sink escapes it.
    const marker = "SERVER SUPPLIED THIS";
    const hostile = createDisconnectingServer(
      `Handshake failed: no matching key exchange algorithm -- ${marker}`,
    );
    const adapter = new SSH2SFTPClientAdapter();
    let thrown: unknown;
    try {
      await adapter.connect(dialOptions(await hostile.port));
    } catch (err) {
      thrown = err;
    } finally {
      await adapter.end().catch(() => {});
      hostile.close();
    }
    const error = thrown as Error;
    expect(error.message).toContain("X25519");
    expect(error.message).not.toContain(marker);
    expect((error.cause as Error).message).toContain(marker);
  });
});

describe("a real OpenSSH server that accepts only what this process cannot perform", () => {
  // The describe above drives the refusal against an in-process `ssh2.Server`,
  // which composes its failure text the way ssh2's own client does. A real
  // OpenSSH sshd answers the same negotiation with an SSH_MSG_DISCONNECT of its
  // own, described `no matching key exchange method found` -- `method`, not the
  // `algorithm` the fragment matches -- so which text reaches `error.message` is
  // a race between ssh2's local negotiation failure and the server's disconnect,
  // and it is settled here rather than reasoned about. It decides the whole
  // control on the deployment this exists for: were the server's text to win,
  // the fast-fail would never fire against OpenSSH at all.
  //
  // The suite's own server on this profile IS that sshd (its policy accepts
  // curve25519 only), so the dial goes to it through the relay, which counts the
  // dials it accepts.
  serverOffersNoPerformableKex(
    "ends the dial at the first refusal, naming the primitive",
    async () => {
      const server = inject("sftpServer");
      const relay = createKexinitRecordingRelay(server);
      const adapter = new SSH2SFTPClientAdapter();
      const { hostKeyFingerprint, ...auth } = serverAuth(server.usera);
      let thrown: unknown;
      try {
        await adapter.connect({
          host: "127.0.0.1",
          port: await relay.port,
          ...auth,
          readyTimeout: 5_000,
          // A budget a retried dial would spend a second at a time, so the
          // single accepted connection below is a classification and not an
          // absent budget.
          maxReconnectAttempts: 3,
        });
      } catch (err) {
        thrown = err;
      } finally {
        await adapter.end().catch(() => {});
        await relay.close();
      }
      const error = thrown as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("X25519");
      expect(error.message).toContain("server's administrator");
      expect((error.cause as Error).message).toContain(
        "no matching key exchange algorithm",
      );
      expect(relay.accepted()).toBe(1);
    },
  );
});
