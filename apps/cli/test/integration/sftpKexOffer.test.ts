import net from "node:net";

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

import type { KexPrimitive } from "../../src/connection/sftpKexCapability";

// What the SFTP client actually OFFERS, read off the wire from the client's own
// SSH_MSG_KEXINIT, with the platform-capability verdict forced to "this process
// cannot perform X25519".
//
// The unit suite pins the OPTIONS the constraint produces; only the installed
// ssh2 can say what those options mean, and every claim about that is settled by
// driving it here rather than by reading its source (CLAUDE.md). Nothing below
// predicts ssh2's behaviour: the listener answers the SSH identification string
// and then decodes the one unencrypted packet ssh2 sends, so what is asserted is
// the byte sequence ssh2 put on the socket.
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

const SSH_MSG_KEXINIT = 20;

// The ten name-lists an SSH_MSG_KEXINIT carries, in wire order (RFC 4253 7.1).
// Only the first is read; the rest are skipped to reach nothing, so this decodes
// exactly one packet and models no part of ssh2.
function decodeOfferedKexAlgorithms(payload: Buffer): string[] {
  if (payload.readUInt8(0) !== SSH_MSG_KEXINIT)
    throw new Error(`first packet was message ${payload.readUInt8(0)}`);
  // message type (1) + cookie (16)
  const length = payload.readUInt32BE(17);
  return payload
    .subarray(21, 21 + length)
    .toString("utf8")
    .split(",");
}

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

// One dial's worth of connect options: no retries, so a listener that never
// completes a handshake costs one attempt rather than the default budget.
const dialOptions = (port: number): Record<string, unknown> => ({
  host: "127.0.0.1",
  port,
  username: "probe",
  password: "probe",
  readyTimeout: 5_000,
  maxReconnectAttempts: 0,
});

async function offeredByAdapter(): Promise<string[]> {
  const reader = createKexinitReader();
  const adapter = new SSH2SFTPClientAdapter();
  try {
    const port = await reader.port;
    await adapter.connect(dialOptions(port)).catch(() => {});
    return await reader.offered;
  } finally {
    await adapter.end().catch(() => {});
    reader.close();
  }
}

async function offeredByBareSsh2(): Promise<string[]> {
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
    });
    const algorithms = await reader.offered;
    client.end();
    return algorithms;
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

  test("the strict-key-exchange marker survives the constraint", () => {
    // ssh2 appends the Terrapin (CVE-2023-48795) strict-kex marker to whatever
    // list is offered. Losing it to the constraint would trade a handshake
    // failure for a downgraded handshake, which is strictly worse.
    expect(bare).toContain("kex-strict-c-v00@openssh.com");
    expect(constrained).toContain("kex-strict-c-v00@openssh.com");
  });

  test("the constraint subtracts from ssh2's offer and adds nothing to it", () => {
    // psilink owns the subtraction; ssh2 keeps ownership of which algorithms
    // exist and in what order. Anything the adapter offered that ssh2 would not
    // have would be psilink choosing a key-exchange algorithm.
    expect(constrained.every((name) => bare.includes(name))).toBe(true);
    expect(constrained).toEqual(bare.filter((name) => !/25519/i.test(name)));
  });
});

describe("the constrained offer against a real SFTP server", () => {
  test("negotiates and connects with no operator configuration", async () => {
    // The whole point of the constraint: on a host missing X25519 the default
    // case must just work. The suite's server offers X25519 FIRST -- so an
    // unconstrained client would win the negotiation with it and die -- and the
    // approved remainder behind it, which is what this dial lands on.
    const server = inject("sftpServer");
    const adapter = new SSH2SFTPClientAdapter();
    try {
      await adapter.connect({
        host: server.host,
        port: server.port,
        username: server.usera.username,
        password: server.usera.password,
        readyTimeout: 5_000,
        maxReconnectAttempts: 0,
      });
      expect(await adapter.list(server.remoteRoot)).toBeInstanceOf(Array);
    } finally {
      await adapter.end().catch(() => {});
    }
  });
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
    expect(error.message).toContain("server administrator");
    // ssh2's own account of the failure is kept, one cause link down.
    expect((error.cause as Error).message).toContain(
      "no matching key exchange algorithm",
    );
  });
});
