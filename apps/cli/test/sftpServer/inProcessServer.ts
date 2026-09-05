import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ssh2 from "ssh2";
import type { Attributes, Connection, SFTPWrapper } from "ssh2";

import { computeHostKeyFingerprint } from "@psilink/core";

import { COUNTED_SFTP_OPS, createSftpSessionControls } from "./sessionControls";
import type {
  ControlledSocket,
  SftpRenameTearControlHub,
  SftpSessionRequestRecorder,
} from "./sessionControls";
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

/**
 * The widest SFTP packet the pinned stack delivers, measured against the
 * real client rather than read out of it: a NAME reply declaring this many
 * payload bytes arrives whole, and one declaring a byte more is refused as a
 * fatal protocol error that takes the SFTP session down with it, with the
 * server told nothing either way.
 *
 * Both sides of the wall are driven in
 * `test/integration/sftpStackPremises.test.ts`.
 *
 * @internal
 */
export const MAX_DELIVERED_SFTP_PAYLOAD_BYTES = 262_144;

/**
 * What a READDIR batch is packed to. Half the wall above, so the per-entry
 * estimate below can be off by a factor of two and the packet still arrives.
 *
 * @internal
 */
export const READDIR_BATCH_BUDGET_BYTES = MAX_DELIVERED_SFTP_PAYLOAD_BYTES / 2;

// A NAME reply's own header (type, request id, entry count), and per entry the
// length prefixes and attribute block SFTPv3 frames around it. Both are
// over-counted: predicting another library's encoder to the byte is what the
// budget's margin exists to avoid needing.
const NAME_PACKET_HEADER_BYTES = 16;
const NAME_ENTRY_FRAMING_BYTES = 64;

// What one entry costs the batch it is packed into.
function nameEntryBytes(filename: string, longname: string): number {
  return (
    NAME_ENTRY_FRAMING_BYTES +
    Buffer.byteLength(filename) +
    Buffer.byteLength(longname)
  );
}

// The one predicate every NAME reply this backend writes is packed against:
// whether a batch already holding `packedBytes` can take an entry of
// `entryBytes` and still arrive.
function nameBatchAdmits(packedBytes: number, entryBytes: number): boolean {
  return packedBytes + entryBytes <= READDIR_BATCH_BUDGET_BYTES;
}

// The malformed-packet injection rides one documented ssh2 internal: the public
// name()/data() server APIs only ever emit well-formed packets, so a malformed
// reply has to be written through the protocol/stream boundary, exactly as a real
// hostile server would put it on the wire. docs/spec/CHANNEL_SECURITY.md documents this
// assumption and a committed adapter test already depends on the same internal.
interface RawChannelSftp {
  _protocol: { channelData(id: unknown, data: Buffer): void };
  outgoing: { id: unknown };
}

// ssh2's server Connection exposes setNoDelay() at runtime (lib/server.js), but
// @types/ssh2 only declares it on the client; cast to reach it server-side.
interface NoDelayConnection {
  setNoDelay(noDelay: boolean): void;
}

// ssh2 holds each connection's transport socket on the Connection's `_sock`,
// server-side as well as client-side. The accept-time session controls reach it
// to stop the server closing the connection on a client's disconnect, and to stop
// it answering the client's handshake at all.
interface SocketBearingConnection {
  _sock?: ControlledSocket;
}

// @types/ssh2 types sftp.on() with a per-opcode overload, so one counting
// listener registered across the whole opcode set goes through the plain
// EventEmitter shape instead.
interface RequestCounterTarget {
  on(event: string, listener: (reqid: number) => void): void;
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

// Two distinct parties, each with a password and a keypair, so the suite can
// drive either auth method against the backend; the keypairs also differ so
// public-key auth is a real credential check, not a rubber stamp.
//
// ECDSA, not ed25519: ssh2's generateKeyPairSync intermittently emits an
// ed25519 OpenSSH private key it cannot parse back ("Malformed OpenSSH
// private key"); ecdsa has not reproduced the fault.
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
 * hooks, the session-lifecycle controls, and a teardown. The globalSetup uses
 * only the handle and stop(); the adversarial tests stand up their own instance
 * to drive the fault hooks, and the connection-lifecycle tests to drive the
 * session controls.
 *
 * @internal exported for testing
 */
export async function startInProcessSftpServer(): Promise<InProcessSftpServer> {
  const parties = makeParties();
  const backingDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "psilink-sftp-inproc-"),
  );
  const hostKey = makeKeyPair();

  // Held behind the accessor below so an over-wide synthetic name is refused
  // where the test arms it, in that test's own stack.
  let oversizeName: string | null = null;

  const inject: SftpFaultInjection = {
    malformedNameOnNextReaddir: false,
    malformedDataOnNextRead: false,
    get oversizeNameOnNextReaddir(): string | null {
      return oversizeName;
    },
    set oversizeNameOnNextReaddir(filename: string | null) {
      if (
        filename !== null &&
        !nameBatchAdmits(
          NAME_PACKET_HEADER_BYTES,
          nameEntryBytes(filename, filename),
        )
      )
        throw new Error(
          `oversizeNameOnNextReaddir: a ${Buffer.byteLength(filename)}-byte filename ` +
            `overruns the ${READDIR_BATCH_BUDGET_BYTES}-byte NAME batch budget, so the ` +
            `reply carrying it would approach the ${MAX_DELIVERED_SFTP_PAYLOAD_BYTES}-byte ` +
            `wall the pinned ssh2 stack refuses a reply at, taking the session down ` +
            `instead of exercising anything.`,
        );
      oversizeName = filename;
    },
    nameReplyFilenameBytesOnNextReaddir: null,
    lastNameReplyPayloadBytes: undefined,
    withholdOn: null,
    renameFailuresRemaining: 0,
    readdirBatchSize: 0,
    emptyNonEofReaddirBatches: 0,
  };

  const sessionControls = createSftpSessionControls();

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
    // The earliest point a control can reach the socket: a connection
    // accepted while the withheld-close control is armed keeps its socket
    // for the whole exchange, so that control has to reach it here rather
    // than at the disconnect it is meant to ignore. The stalled-handshake
    // control's mute takes hold once ssh2 has written the server's
    // identification string, which is the stall a case measures against.
    sessionControls.onConnectionAccepted(
      (client as unknown as SocketBearingConnection)._sock,
    );
    // Disable Nagle, matching a real OpenSSH server. Left on, the small SFTP
    // request/response writes collide with TCP delayed-ACK and stall ~40ms each
    // on Linux; that is negligible per call but compounds over the thousands of
    // round-trips in a full PSI exchange, stretching a ~3s exchange to tens of
    // seconds on a CI runner (macOS loopback masks it, Linux does not).
    (client as unknown as NoDelayConnection).setNoDelay(true);
    // A peer reset (the adversarial tests abort mid-stream) appears as an
    // 'error' on the connection; without a listener it would crash the test
    // process. There is nothing to recover here -- the connection is going away.
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("close", () => sessionControls.releaseConnection(client));

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
      // The socket goes with the connection so a mid-exchange control can reach
      // an established session's transport; at accept time the hub has no
      // connection to key it on.
      sessionControls.onConnectionReady(
        client,
        (client as unknown as SocketBearingConnection)._sock,
      );
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          // Count each SFTP request for the session op caps and one-shot op
          // drop. A cap that fires arms the drop as this request is counted; the
          // teardown may pre-empt this request's own reply (a mid-request cut),
          // so a counted op is not guaranteed to complete before the drop.
          const requests = sessionControls.trackSftpSession();
          const counter = sftp as unknown as RequestCounterTarget;
          for (const op of COUNTED_SFTP_OPS) {
            counter.on(op, (reqid: number) => {
              requests.received(op, reqid);
              sessionControls.recordOp(client);
            });
          }
          const closeOpenHandles = attachSftpHandlers(
            sftp,
            backingDir,
            inject,
            sessionControls.renameTear,
            () => sessionControls.tearSession(client),
            requests,
          );
          // A graceful client sends CLOSE per handle; an abrupt disconnect (the
          // adversarial tests abort mid-stream) does not, so close any fds still
          // open for this session when the connection drops.
          client.on("close", () => {
            closeOpenHandles();
            requests.release();
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    // Before the server is listening a 'listen' failure (e.g. the loopback port
    // races away) arrives as an 'error' event; report it as a rejected start
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

  // The OpenSSH SHA256 fingerprint of the server's host key, computed over the
  // SSH wire-format public-key blob (getPublicSSH()) -- the exact bytes ssh2's
  // hostVerifier receives -- so it equals what the production verifier pins.
  const hostKeyFingerprint = await computeHostKeyFingerprint(
    new Uint8Array(publicKeyOf(hostKey).data),
  );

  const handle: SftpServerHandle = {
    host: "127.0.0.1",
    port,
    backingDir,
    remoteRoot: REMOTE_ROOT,
    hostKeyFingerprint,
    usera: {
      username: parties.usera.username,
      password: parties.usera.password,
      privateKey: parties.usera.key.private,
      hostKeyFingerprint,
    },
    userb: {
      username: parties.userb.username,
      password: parties.userb.password,
      privateKey: parties.userb.key.private,
      hostKeyFingerprint,
    },
  };

  return {
    handle,
    inject,
    sessionControls,
    async stop() {
      // Disarm the withheld-close control and hand the real closers back to the
      // sockets it silenced: end() below reaches those sockets, and a silenced one
      // would leave server.close() waiting on a connection that can never end. A
      // socket muted by the stalled-handshake control cannot answer that end()
      // either, so it is handed its write back on the same terms.
      sessionControls.stopWithholdingCloses();
      sessionControls.stopStallingHandshakes();
      // A vanished session is silenced on both halves at once, so it cannot
      // answer that end() either.
      sessionControls.restoreVanishedSessions();
      // Release any probe parked on a consumption that is no longer coming, so a
      // held reply does not outlive the server it was served by.
      sessionControls.renameTear.reset();
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
  renameTear: SftpRenameTearControlHub,
  tearSession: () => void,
  requests: SftpSessionRequestRecorder,
): () => void {
  // A forced session drop (the session-control tests cut a connection
  // mid-batch) can land while an fs callback below is still pending; when
  // that callback then writes its reply, the channel is already ended.
  // ssh2's send path no-ops a write to a closed channel today, but a
  // synchronous throw there would crash the test worker, so wrap every
  // server reply write to swallow it.
  const replyMethods = ["status", "data", "name", "attrs", "handle"] as const;
  const guarded = sftp as unknown as Record<
    (typeof replyMethods)[number],
    (...args: unknown[]) => void
  >;
  for (const method of replyMethods) {
    const original = guarded[method];
    guarded[method] = (...args: unknown[]): void => {
      // Every server reply holds its request id first, so this is also where
      // the request meter learns a request is no longer outstanding. Noted
      // before the write, so a reply the channel can no longer send still
      // clears the request the server has finished with.
      requests.answered(args[0] as number);
      try {
        original.call(sftp, ...args);
      } catch {
        // channel already ended by a forced session drop
      }
    };
  }

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

  // The payload length ssh2 declared for the reply `write` produces, read off the
  // leading bytes it hands the protocol: the encoder's own number, which is what
  // a case measuring what the stack still delivers needs and what no estimate
  // here could supply. Undefined when the write reached the protocol with fewer
  // bytes than a length prefix.
  const declaredPayloadBytesOf = (write: () => void): number | undefined => {
    const raw = sftp as unknown as RawChannelSftp;
    const protocol = raw._protocol;
    const original = protocol.channelData;
    let declared: number | undefined;
    protocol.channelData = (id: unknown, data: Buffer): void => {
      if (declared === undefined && data.length >= 4)
        declared = data.readUInt32BE(0);
      original.call(protocol, id, data);
    };
    try {
      write();
    } finally {
      protocol.channelData = original;
    }
    return declared;
  };

  sftp.on("REALPATH", (reqid: number, p: string) => {
    if (inject.withholdOn === "REALPATH") return;
    // Echo the requested path back as its own canonical form. This leaks nothing
    // and cannot bypass confinement: the value returned is the client's own
    // virtual path, never a backingDir-rooted host path, and every actual file
    // operation re-confines independently through resolve() regardless of what
    // REALPATH returned. Routing it through resolve() would be wrong -- that
    // returns the host path and would expose backingDir.
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
      // ENOENT is a missing path; anything else (ENOTDIR when a file is
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
    if (inject.nameReplyFilenameBytesOnNextReaddir !== null) {
      // One entry of the width the case asked for, then EOF on the next READDIR.
      // Written through ssh2's own encoder rather than framed here, because what
      // the case is measuring is the reply the stack itself puts on the wire --
      // and the width ssh2 declared for it is recorded rather than predicted.
      const filenameBytes = inject.nameReplyFilenameBytesOnNextReaddir;
      inject.nameReplyFilenameBytesOnNextReaddir = null;
      h.pos = h.names.length;
      inject.lastNameReplyPayloadBytes = declaredPayloadBytesOf(() =>
        sftp.name(reqid, [
          {
            filename: "x".repeat(filenameBytes),
            longname: "",
            attrs: attrsFromStat({ size: 0 }),
          },
        ]),
      );
      return;
    }
    if (inject.emptyNonEofReaddirBatches > 0) {
      // A NAME reply holding no entry and no end-of-directory status: the batch
      // advances the listing by nothing while telling the client there is more
      // to come. Written through the server's own name() so the frame is the
      // stack's, not this file's.
      inject.emptyNonEofReaddirBatches -= 1;
      return sftp.name(reqid, []);
    }
    if (h.pos >= h.names.length) return sftp.status(reqid, STATUS_CODE.EOF);

    // Realistic batching, bounded by the caller's cap where one is set AND by
    // what a single NAME packet holds, resuming from the handle's stored
    // position: a directory wider than one packet is served over as many round
    // trips as it takes, the way a real server answers one.
    const cap = inject.readdirBatchSize || h.names.length;
    const entries: {
      filename: string;
      longname: string;
      attrs: Attributes;
    }[] = [];
    let packed = NAME_PACKET_HEADER_BYTES;
    while (h.pos < h.names.length && entries.length < cap) {
      const name = h.names[h.pos];
      // Keep the full stat shape attrsFromStat reads -- a `{ size: number }`
      // annotation would narrow mode/atime/mtime away and force every entry to
      // report Date.now() instead of its real timestamps.
      let st: { size: number; mode?: number; atime?: Date; mtime?: Date };
      try {
        st = fs.statSync(path.join(h.dirPath, name));
      } catch {
        st = { size: 0 };
      }
      const longname = `-rw-r--r-- 1 user user ${st.size} Jan 1 00:00 ${name}`;
      const entryBytes = nameEntryBytes(name, longname);
      if (!nameBatchAdmits(packed, entryBytes)) {
        // One entry that overruns the budget on its own cannot be split across
        // round trips, so refuse the listing where the client can see it rather
        // than write a reply wide enough to take the session down.
        if (entries.length === 0)
          return sftp.status(reqid, STATUS_CODE.FAILURE);
        break;
      }
      entries.push({ filename: name, longname, attrs: attrsFromStat(st) });
      packed += entryBytes;
      h.pos += 1;
    }
    sftp.name(reqid, entries);
  });

  // STAT follows symlinks; LSTAT must not (SFTP spec). No symlinks exist in the
  // backing dir today, but keeping the contract correct avoids a future test that
  // plants one silently getting dereferenced.
  const onStat = (op: "STAT" | "LSTAT", statFn: typeof fs.stat) => {
    const answer = (reqid: number, p: string): void => {
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
    return (reqid: number, p: string): void => {
      if (inject.withholdOn === op) return;
      // Order the staged tear's two observers: a probe of the torn destination is
      // held until that destination has been REMOVEd, so "the partner consumed
      // it" strictly precedes "the probe read it" however the two would otherwise
      // interleave.
      if (
        renameTear.holdProbeUntilDestinationConsumed &&
        renameTear.tornDestination === p
      ) {
        void renameTear.waitForConsumption().then(() => answer(reqid, p));
        return;
      }
      // A generic failure rather than NO_SUCH_FILE: what the probe must not be
      // able to conclude is that the destination is absent, so the publish stays
      // undetermined instead of being decided either way.
      if (
        renameTear.refuseProbeOfTornDestination &&
        renameTear.tornDestination === p
      )
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      answer(reqid, p);
    };
  };
  sftp.on("STAT", onStat("STAT", fs.stat));
  sftp.on("LSTAT", onStat("LSTAT", fs.lstat));

  sftp.on("REMOVE", (reqid: number, p: string) => {
    if (inject.withholdOn === "REMOVE") return;
    // Acknowledged, not performed: the torn publish's message file stays on the
    // server, which is the residue a plain retry then meets.
    if (
      renameTear.preserveTornDestinationOnRemove &&
      renameTear.tornDestination === p
    )
      return sftp.status(reqid, STATUS_CODE.OK);
    fs.unlink(resolve(p), (err) => {
      if (!err) renameTear.noteRemoved(p);
      if (err && err.code === "ENOENT")
        return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
    });
  });

  sftp.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
    if (inject.withholdOn === "RENAME") return;
    // Staged tear with nothing landed: no filesystem work runs, so the
    // destination never exists and the source is left for a re-issue.
    if (renameTear.tearBeforeRenameLands) {
      renameTear.tearBeforeRenameLands = false;
      renameTear.noteTorn(newPath);
      tearSession();
      return;
    }
    if (inject.renameFailuresRemaining > 0) {
      // SSH_FX_FAILURE (status 4) N times, then let it through, so the adapter's
      // generic-failure rename retry recovers against a real server.
      inject.renameFailuresRemaining -= 1;
      return sftp.status(reqid, STATUS_CODE.FAILURE);
    }
    fs.rename(resolve(oldPath), resolve(newPath), (err) => {
      // Staged tear with the publish durably in place: end the connection here,
      // in the callback the filesystem work completed in, instead of writing the
      // reply, so the client's rename is torn off the wire over a destination
      // that exists.
      if (!err && renameTear.tearAfterRenameLands) {
        renameTear.tearAfterRenameLands = false;
        renameTear.noteTorn(newPath);
        if (renameTear.consumeDestinationAtTear) {
          // `force` so a failure here cannot throw out of an fs callback and past
          // the connection-level error handler; the case's own assertion on the
          // torn destination is what proves the removal happened.
          fs.rmSync(resolve(newPath), { force: true });
          renameTear.noteRemoved(newPath);
        }
        tearSession();
        return;
      }
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
