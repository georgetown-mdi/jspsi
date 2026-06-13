import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ssh2 from "ssh2";
import type { Attributes, Connection, SFTPWrapper } from "ssh2";

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

  // Track live connections so stop() can force them closed: server.close() only
  // fires its callback once every connection has ended, so a still-connected
  // adapter at teardown would otherwise hang the runner indefinitely.
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    // A peer reset (the adversarial tests deliberately abort mid-stream) surfaces
    // as an 'error' on the connection; without a listener it would crash the test
    // process. There is nothing to recover here -- the connection is going away.
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));

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
          const closeOpenHandles = attachSftpHandlers(sftp, backingDir, inject);
          // A graceful client sends CLOSE per handle; an abrupt disconnect (the
          // adversarial tests abort mid-stream) does not, so close any fds still
          // open for this session when the connection drops.
          client.on("close", closeOpenHandles);
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    // Before the server is listening a 'listen' failure (e.g. the loopback port
    // races away) arrives as an 'error' event; surface it as a rejected start
    // rather than an uncaught crash.
    const onStartupError = (err: Error): void => reject(err);
    server.once("error", onStartupError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onStartupError);
      // Past startup, swallow server-level errors so a late socket fault cannot
      // crash the test process; the connection-level handler covers per-client.
      server.on("error", () => {});
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("in-process SFTP server reported no listen address"));
        return;
      }
      resolve(address.port);
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
      // Force any still-open connection closed so server.close()'s callback can
      // fire, then bound the wait so a connection that refuses to end cannot hang
      // teardown forever.
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // already torn down
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      await fsp.rm(backingDir, { recursive: true, force: true });
    },
  };
}

// Map an OPEN flags bitfield to an fs flags value.
function openFlagsToFsFlags(flags: number): string | number {
  const write = !!(flags & OPEN_MODE.WRITE);
  const append = !!(flags & OPEN_MODE.APPEND);
  const creat = !!(flags & OPEN_MODE.CREAT);
  const trunc = !!(flags & OPEN_MODE.TRUNC);
  const excl = !!(flags & OPEN_MODE.EXCL);
  if (excl && creat && write) return "wx"; // exclusive create (createExclusive)
  if (write && append) return "a";
  if (write && creat && trunc) return "w";
  // WRITE+CREAT without TRUNC must create-if-absent yet preserve an existing
  // file's bytes; no fs flag string expresses that ("w" truncates), so use the
  // numeric open mode directly.
  if (write && creat) return fs.constants.O_CREAT | fs.constants.O_WRONLY;
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

// Returns a cleanup that closes any file descriptors still open for this session
// (a client that disconnects without sending CLOSE would otherwise leak them).
function attachSftpHandlers(
  sftp: SFTPWrapper,
  backingDir: string,
  inject: SftpFaultInjection,
): () => void {
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
  // root, then resolve the remainder under backingDir with chroot semantics --
  // normalizing as an absolute path within the served root collapses any `..`
  // segments against the root, so a path like `/psi/../../etc/passwd` can never
  // escape backingDir (plain path.join would let it resolve outside).
  const resolve = (p: string): string => {
    // Strip the virtual /psi root with plain string ops -- a dynamic RegExp built
    // from REMOTE_ROOT would misbehave if the constant ever held regex
    // metacharacters -- then confine the remainder under backingDir with chroot
    // semantics so traversal segments collapse against the served root.
    let rel = p;
    if (rel === REMOTE_ROOT) rel = "";
    else if (rel.startsWith(`${REMOTE_ROOT}/`))
      rel = rel.slice(REMOTE_ROOT.length + 1);
    rel = rel.replace(/^\/+/, "");
    const confined = path.posix.normalize(`/${rel}`).replace(/^\/+/, "");
    return path.join(backingDir, confined);
  };

  const injectRaw = (packet: Buffer): void => {
    const raw = sftp as unknown as RawChannelSftp;
    raw._protocol.channelData(raw.outgoing.id, packet);
  };

  sftp.on("REALPATH", (reqid: number, p: string) => {
    // Echo the requested path back as its own canonical form. This leaks nothing
    // and cannot bypass confinement: the value returned is the client's own
    // virtual path, never a backingDir-rooted host path, and every actual file
    // operation re-confines independently through resolve() regardless of what
    // REALPATH returned. In practice the production adapter addresses files by
    // absolute path and never emits a REALPATH request at all (ssh2-sftp-client
    // only canonicalizes paths beginning with "." or ".."), so this handler is
    // here for generic SFTP-client compatibility, not for any path this suite
    // drives. Routing it through resolve() would be wrong -- that returns the
    // host path and would expose backingDir.
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
    if (inject.withholdOn === "FSTAT") return;
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
      // ENOENT is a missing path; anything else (notably ENOTDIR when a file is
      // opened as a directory) is a generic failure, matching OpenSSH and the
      // OPEN handler's own dispatch rather than masking it as NO_SUCH_FILE.
      if (err)
        return sftp.status(
          reqid,
          err.code === "ENOENT"
            ? STATUS_CODE.NO_SUCH_FILE
            : STATUS_CODE.FAILURE,
        );
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
      // Carry the full stat shape attrsFromStat reads -- a `{ size: number }`
      // annotation would narrow mode/atime/mtime away and force every entry to
      // report Date.now() instead of its real timestamps.
      let st: { size: number; mode?: number; atime?: Date; mtime?: Date };
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

  // STAT follows symlinks; LSTAT must not (SFTP spec). No symlinks exist in the
  // backing dir today, but keeping the contract honest avoids a future test that
  // plants one silently getting dereferenced.
  const onStat =
    (op: "STAT" | "LSTAT", statFn: typeof fs.stat) =>
    (reqid: number, p: string) => {
      if (inject.withholdOn === op) return;
      statFn(resolve(p), (err, st) => {
        // Only a genuinely missing path is NO_SUCH_FILE; anything else (EACCES,
        // ENOTDIR) is a generic failure, matching the OPEN/OPENDIR handlers so a
        // distinct error code is not flattened into "missing file".
        if (err)
          return sftp.status(
            reqid,
            err.code === "ENOENT"
              ? STATUS_CODE.NO_SUCH_FILE
              : STATUS_CODE.FAILURE,
          );
        sftp.attrs(reqid, attrsFromStat(st));
      });
    };
  sftp.on("STAT", onStat("STAT", fs.stat));
  sftp.on("LSTAT", onStat("LSTAT", fs.lstat));

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

  return () => {
    for (const h of handles.values()) {
      if (h.type === "file") fs.close(h.fd, () => {});
    }
    handles.clear();
  };
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
