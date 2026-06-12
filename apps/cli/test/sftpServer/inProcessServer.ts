import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ssh2 from "ssh2";
import type { Attributes, SFTPWrapper } from "ssh2";

import type {
  InProcessSftpServer,
  SftpFaultInjection,
  SftpServerHandle,
} from "./types";

const { Server, utils } = ssh2;
const {
  generateKeyPairSync,
  parseKey,
  sftp: { OPEN_MODE, STATUS_CODE },
} = utils;

// SSH_FXP_NAME and SSH_FXP_DATA response packet types (RESPONSE.NAME / .DATA in
// ssh2/lib/protocol/SFTP.js). Used to frame the malformed replies the adversarial
// tests inject straight onto the channel.
const RESPONSE_NAME = 104;
const RESPONSE_DATA = 103;

// The virtual root the in-process backend serves: a client connection path of
// `/psi/<ns>` is mapped to `<backingDir>/<ns>` on the host. The native sshd
// backend serves backingDir at its real path instead, which is why tests take
// the remote root from the handle rather than hardcoding `/psi`.
const REMOTE_ROOT = "/psi";

// The malformed-packet injection rides one documented ssh2 internal: the public
// name()/data() server APIs only ever emit well-formed packets, so a malformed
// reply has to be written through the protocol/stream seam, exactly as a real
// hostile server would put it on the wire. docs/SECURITY_DESIGN.md documents this
// premise and a committed adapter test already depends on the same internal.
interface RawChannelSftp {
  _protocol: { channelData(id: unknown, data: Buffer): void };
  outgoing: { id: unknown };
}

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

// A NAME packet that claims one entry (count = 1) but supplies no filename bytes,
// so ssh2's parser reads the filename as undefined and falls into
// doFatalSFTPError('Malformed NAME packet') -> sftp.emit('error').
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

// Two DISTINCT parties. Each has a password AND a keypair so the suite can drive
// either auth method against the same backend; the keypairs are also distinct so
// public-key auth is a genuine credential check, not a rubber stamp.
//
// ECDSA, not ed25519: ssh2's generateKeyPairSync intermittently emits an ed25519
// OpenSSH private key it cannot parse back ("Malformed OpenSSH private key"); the
// key type is irrelevant to what these tests exercise, and ecdsa has not
// reproduced the fault.
function makeKeyPair(): { private: string; public: string } {
  return generateKeyPairSync("ecdsa", { bits: 256 });
}

interface InProcessParty {
  username: string;
  password: string;
  key: { private: string; public: string };
}

function makeParties(): { usera: InProcessParty; userb: InProcessParty } {
  return {
    usera: { username: "usera", password: "usera", key: makeKeyPair() },
    userb: { username: "userb", password: "userb", key: makeKeyPair() },
  };
}

// Parse a generated public key into the comparable algo/data form ssh2 hands us
// on the authentication context, so the backend can match an offered key.
function publicKeyOf(generated: { public: string }): {
  algo: string;
  data: Buffer;
} {
  const parsed = parseKey(generated.public);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return { algo: key.type, data: key.getPublicSSH() };
}

/**
 * Start an in-process ssh2 SFTP server bound to loopback on an ephemeral port,
 * serving a fresh temporary directory. Returns the connection handle, the fault
 * hooks, and a teardown. The globalSetup uses only the handle and stop(); the
 * adversarial tests stand up their own instance to drive the fault hooks.
 *
 * @internal exported for testing
 */
export async function startInProcessSftpServer(): Promise<InProcessSftpServer> {
  const parties = makeParties();
  const backingDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "psilink-sftp-inproc-"),
  );
  const hostKey = makeKeyPair();

  const inject: SftpFaultInjection = {
    malformedNameOnNextReaddir: false,
    malformedDataOnNextRead: false,
    oversizeNameOnNextReaddir: null,
    withholdOn: null,
    renameFailuresRemaining: 0,
    readdirBatchSize: 0,
  };

  const acceptableKey: Record<string, { algo: string; data: Buffer }> = {
    usera: publicKeyOf(parties.usera.key),
    userb: publicKeyOf(parties.userb.key),
  };

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => {
      const party =
        ctx.username === "usera"
          ? parties.usera
          : ctx.username === "userb"
            ? parties.userb
            : undefined;
      if (!party) return ctx.reject(["password", "publickey"]);

      if (ctx.method === "password") {
        if (ctx.password === party.password) return ctx.accept();
        return ctx.reject(["password", "publickey"]);
      }

      if (ctx.method === "publickey") {
        const want = acceptableKey[ctx.username];
        const sameAlgo = ctx.key.algo === want.algo;
        const sameData = sameAlgo && ctx.key.data.equals(want.data);
        if (!sameData) return ctx.reject(["password", "publickey"]);
        if (!ctx.signature) {
          // Probe phase: the key is acceptable; the client re-sends signed.
          return ctx.accept();
        }
        // Signature phase: verify the signature against the offered key so this
        // is real public-key auth.
        const verifier = parseKey(party.key.public);
        if (verifier instanceof Error)
          return ctx.reject(["password", "publickey"]);
        const key = Array.isArray(verifier) ? verifier[0] : verifier;
        if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
          return ctx.accept();
        }
        return ctx.reject(["password", "publickey"]);
      }

      return ctx.reject(["password", "publickey"]);
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          attachSftpHandlers(sftp, backingDir, inject);
        });
      });
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", function (this: typeof server) {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const handle: SftpServerHandle = {
    host: "127.0.0.1",
    port,
    backingDir,
    remoteRoot: REMOTE_ROOT,
    usera: {
      username: parties.usera.username,
      password: parties.usera.password,
      privateKey: parties.usera.key.private,
    },
    userb: {
      username: parties.userb.username,
      password: parties.userb.password,
      privateKey: parties.userb.key.private,
    },
  };

  return {
    handle,
    inject,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(backingDir, { recursive: true, force: true });
    },
  };
}

// Map an OPEN flags bitfield to an fs flags string.
function openFlagsToFsFlags(flags: number): string {
  const write = !!(flags & OPEN_MODE.WRITE);
  const append = !!(flags & OPEN_MODE.APPEND);
  const creat = !!(flags & OPEN_MODE.CREAT);
  const trunc = !!(flags & OPEN_MODE.TRUNC);
  const excl = !!(flags & OPEN_MODE.EXCL);
  if (excl && creat && write) return "wx"; // exclusive create (createExclusive)
  if (write && append) return "a";
  if (write && creat && trunc) return "w";
  if (write && creat) return "w";
  if (write) return "r+";
  return "r";
}

interface FileHandle {
  type: "file";
  fd: number;
}
interface DirHandle {
  type: "dir";
  names: string[];
  pos: number;
  dirPath: string;
}
type OpenHandle = FileHandle | DirHandle;

function attachSftpHandlers(
  sftp: SFTPWrapper,
  backingDir: string,
  inject: SftpFaultInjection,
): void {
  const handles = new Map<number, OpenHandle>();
  let nextHandle = 0;
  const newHandle = (entry: OpenHandle): Buffer => {
    const id = nextHandle++;
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    handles.set(id, entry);
    return buf;
  };
  const lookup = (handleBuf: Buffer): OpenHandle | undefined =>
    handleBuf.length === 4 ? handles.get(handleBuf.readUInt32BE(0)) : undefined;

  // Confine a client-supplied path to the backing dir: strip the virtual /psi
  // root, then resolve the remainder under backingDir.
  const resolve = (p: string): string => {
    const rel = p
      .replace(new RegExp(`^${REMOTE_ROOT}/?`), "")
      .replace(/^\/+/, "");
    return path.join(backingDir, rel);
  };

  const injectRaw = (packet: Buffer): void => {
    const raw = sftp as unknown as RawChannelSftp;
    raw._protocol.channelData(raw.outgoing.id, packet);
  };

  sftp.on("REALPATH", (reqid: number, p: string) => {
    // ssh2-sftp-client calls realpath on connect/cwd; echo the rooted path back.
    sftp.name(reqid, [
      { filename: p, longname: p, attrs: attrsFromStat({ size: 0 }) },
    ]);
  });

  sftp.on("OPEN", (reqid: number, filename: string, flags: number) => {
    if (inject.withholdOn === "OPEN") return;
    fs.open(resolve(filename), openFlagsToFsFlags(flags), (err, fd) => {
      if (err) {
        // EEXIST on exclusive create -> SSH_FX_FAILURE (status 4), exactly as
        // OpenSSH's SFTPv3 default does, so the adapter's generic-failure
        // disambiguation for createExclusive stays under test.
        if (err.code === "EEXIST")
          return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (err.code === "ENOENT")
          return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      }
      sftp.handle(reqid, newHandle({ type: "file", fd }));
    });
  });

  sftp.on(
    "READ",
    (reqid: number, handleBuf: Buffer, offset: number, length: number) => {
      if (inject.withholdOn === "READ") return;
      if (inject.malformedDataOnNextRead) {
        inject.malformedDataOnNextRead = false;
        return injectRaw(malformedDataPacket(reqid));
      }
      const h = lookup(handleBuf);
      if (!h || h.type !== "file")
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      const buf = Buffer.alloc(length);
      fs.read(h.fd, buf, 0, length, offset, (err, bytesRead) => {
        if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.data(reqid, buf.subarray(0, bytesRead));
      });
    },
  );

  sftp.on(
    "WRITE",
    (reqid: number, handleBuf: Buffer, offset: number, data: Buffer) => {
      if (inject.withholdOn === "WRITE") return;
      const h = lookup(handleBuf);
      if (!h || h.type !== "file")
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      fs.write(h.fd, data, 0, data.length, offset, (err) => {
        sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
      });
    },
  );

  sftp.on("FSTAT", (reqid: number, handleBuf: Buffer) => {
    const h = lookup(handleBuf);
    if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.fstat(h.fd, (err, st) => {
      if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.attrs(reqid, attrsFromStat(st));
    });
  });

  sftp.on("CLOSE", (reqid: number, handleBuf: Buffer) => {
    if (inject.withholdOn === "CLOSE") return;
    const id = handleBuf.length === 4 ? handleBuf.readUInt32BE(0) : -1;
    const h = handles.get(id);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(id);
    if (h.type === "file") {
      fs.close(h.fd, () => sftp.status(reqid, STATUS_CODE.OK));
    } else {
      sftp.status(reqid, STATUS_CODE.OK);
    }
  });

  sftp.on("OPENDIR", (reqid: number, p: string) => {
    if (inject.withholdOn === "OPENDIR") return;
    const dirPath = resolve(p);
    fs.readdir(dirPath, (err, names) => {
      if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.handle(reqid, newHandle({ type: "dir", names, pos: 0, dirPath }));
    });
  });

  sftp.on("READDIR", (reqid: number, handleBuf: Buffer) => {
    if (inject.withholdOn === "READDIR") return;
    if (inject.malformedNameOnNextReaddir) {
      inject.malformedNameOnNextReaddir = false;
      return injectRaw(malformedNamePacket(reqid));
    }
    const h = lookup(handleBuf);
    if (!h || h.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (inject.oversizeNameOnNextReaddir !== null) {
      // Serve one well-formed but over-length NAME entry, then EOF on the next
      // READDIR, so the directory-listing length bound is hit on real wire bytes.
      const filename = inject.oversizeNameOnNextReaddir;
      inject.oversizeNameOnNextReaddir = null;
      h.pos = h.names.length;
      return sftp.name(reqid, [
        { filename, longname: filename, attrs: attrsFromStat({ size: 0 }) },
      ]);
    }
    if (h.pos >= h.names.length) return sftp.status(reqid, STATUS_CODE.EOF);

    // Realistic batching: hand back at most readdirBatchSize names per round-trip
    // when set, otherwise the whole listing in one batch.
    const batchSize = inject.readdirBatchSize || h.names.length;
    const slice = h.names.slice(h.pos, h.pos + batchSize);
    h.pos += slice.length;
    const entries = slice.map((name) => {
      let st: { size: number };
      try {
        st = fs.statSync(path.join(h.dirPath, name));
      } catch {
        st = { size: 0 };
      }
      return {
        filename: name,
        longname: `-rw-r--r-- 1 user user ${st.size} Jan 1 00:00 ${name}`,
        attrs: attrsFromStat(st),
      };
    });
    sftp.name(reqid, entries);
  });

  const onStat = (reqid: number, p: string) => {
    if (inject.withholdOn === "STAT") return;
    fs.stat(resolve(p), (err, st) => {
      if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.attrs(reqid, attrsFromStat(st));
    });
  };
  sftp.on("STAT", onStat);
  sftp.on("LSTAT", onStat);

  sftp.on("REMOVE", (reqid: number, p: string) => {
    if (inject.withholdOn === "REMOVE") return;
    fs.unlink(resolve(p), (err) => {
      if (err && err.code === "ENOENT")
        return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
    });
  });

  sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
    if (inject.withholdOn === "RENAME") return;
    if (inject.renameFailuresRemaining > 0) {
      // SSH_FX_FAILURE (status 4) N times, then let it through, so the adapter's
      // generic-failure rename retry recovers against a real server.
      inject.renameFailuresRemaining -= 1;
      return sftp.status(reqid, STATUS_CODE.FAILURE);
    }
    fs.rename(resolve(oldPath), resolve(newPath), (err) => {
      if (err && err.code === "ENOENT")
        return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
    });
  });

  sftp.on("MKDIR", (reqid: number, p: string) => {
    fs.mkdir(resolve(p), (err) =>
      sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
    );
  });
  sftp.on("RMDIR", (reqid: number, p: string) => {
    fs.rmdir(resolve(p), (err) =>
      sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
    );
  });
}

function attrsFromStat(st: {
  size: number;
  mode?: number;
  atime?: Date;
  mtime?: Date;
}): Attributes {
  const toSec = (t: Date | undefined): number =>
    t ? Math.floor(t.getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    mode: st.mode === undefined ? 0o644 : st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: toSec(st.atime),
    mtime: toSec(st.mtime),
  };
}
