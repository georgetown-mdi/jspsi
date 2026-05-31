import * as z from "zod";
import { default as EventEmitter } from "eventemitter3";
import { v4 as uuidv4 } from "uuid";

import { getLoggerForVerbosity } from "../utils/logger";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../config/connection";
import type { HandshakeRole } from "../types";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Extracts the declared byte count from a message filename by reading the last
// `-`-delimited segment before `.json`. Parsing is right-anchored so an id
// containing hyphens (a UUID, or a configured peer id) cannot corrupt the
// result regardless of how many segments precede the count. Returns undefined
// when that segment is not a non-negative integer.
const parseMessageByteCount = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const lastSegment = stem.slice(stem.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(lastSegment)) return undefined;
  return Number(lastSegment);
};

/**
 * Default peer-inactivity budget (1 hour) used when `peerTimeoutMs` is not
 * supplied in the connection options. Bounds how long this side waits for the
 * peer before treating silence as a transport failure: it is the fallback both
 * for the file-sync rendezvous time-to-live and for the CLI's
 * {@link fromEventConnection} inactivity deadline.
 */
export const DEFAULT_PEER_TIMEOUT_MS = 1000 * 60 * 60;
const DEFAULT_POLLING_FREQUENCY_MS = 100;
const DEFAULT_VERBOSITY = 1;
// Consecutive ENOENT from get() after list() surfaced the file indicates a
// filesystem state that is unlikely to self-resolve: emit an error rather
// than looping silently until the peer timeout fires.
//
// 3 is structural rather than performance-tuning, so it is not exposed as a
// config option: one ENOENT after the file appeared in list() is the expected
// TOCTOU race when the peer's cleanup runs between the listing and the get()
// (a single race per message-consumption cycle); two more in a row indicates
// the directory listing is not converging, which is pathological. A smaller
// threshold (1-2) produces false positives on slow filesystems where one
// peer's cleanup may briefly overlap with our next poll; a larger threshold
// (>5) approaches the peer timeout and gives no practical benefit.
const MAX_CONSECUTIVE_ENOENT = 3;

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

interface Options {
  // Optional: when not supplied to the constructor, open() sets this from
  // `config.options.peerTimeoutMs` (or DEFAULT_PEER_TIMEOUT_MS) so the budget
  // is not consumed by the time between construction and synchronize().
  timeToLive?: Date;
  pollingFrequency: number;
  verbose: number;
  timestampInFilename: boolean;
  // Raw peer-timeout duration stored alongside timeToLive so close() can
  // compute a fresh drain deadline independent of exchange duration. Set from
  // config in open(); may be supplied in the constructor for tests.
  peerTimeoutMs?: number;
}

const Message = z.object({
  ts: z.number().nonnegative(),
  seq: z.number().nonnegative(),
  type: z.literal(["Object", "Uint8Array"]),
  payload: z.json(),
});

const getDefaultOptions = (): Options => {
  return {
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY,
    timestampInFilename: false,
  };
};

export interface FileInfo {
  name: string;
  // Retained for downstream transport consumers; no longer used by the
  // rendezvous tiebreaker (see waitForPeer), which orders on UUID alone
  // because sync tools stamp transfer time rather than creation time.
  modifyTime: number;
  // On-disk byte count, populated by every FileTransportClient.list(). poll()
  // compares it against the declared count encoded in a message filename so a
  // partially synced file is not read as a complete message.
  size: number;
}

export interface PutOptions {
  mode?: number | string;
  flags?: "w" | "a";
  encoding?: null | string;
}

export interface GetOptions {
  mode?: number | string;
  flags?: "r";
  encoding?: null | string;
  handle?: null | string;
}

/**
 * Abstract file transport used by {@link FileSyncConnection}. Implemented by
 * {@link SSH2SFTPClientAdapter} for real SFTP servers and by `LocalFSClient`
 * for locally-mounted network folders.
 */
export interface FileTransportClient {
  /**
   * Options are defined by transport providers and must match their expected
   * names and types.
   */
  connect: (options: Record<string, unknown>) => Promise<void>;
  end: () => Promise<void>;
  list: (path: string) => Promise<Array<FileInfo>>;
  get: (path: string, options?: GetOptions) => Promise<Buffer<ArrayBufferLike>>;
  put: (
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ) => Promise<unknown>;
  delete: (path: string) => Promise<void>;
  safeDelete: (path: string) => Promise<void>;
  rename: (fromPath: string, toPath: string) => Promise<void>;
  /**
   * Creates an empty file at `path` atomically. Throws with
   * `code === "EEXIST"` (or an equivalent server error) if `path` already
   * exists, giving atomic "only one winner" semantics for the wave-file race.
   */
  createExclusive: (path: string) => Promise<void>;
  exists: (remotePath: string) => Promise<boolean>;
}

/**
 * File-based rendezvous and message-passing connection. Implements the
 * `.hello`/`.wave` handshake and `.json` polling protocol over any
 * {@link FileTransportClient} — an SFTP server via
 * {@link SSH2SFTPClientAdapter} or a locally-mounted folder via
 * `LocalFSClient`.
 */
export class FileSyncConnection extends EventEmitter<Events, never> {
  private client: FileTransportClient;
  id: string;
  role: string;
  options: Options;
  log: ReturnType<typeof getLoggerForVerbosity>;
  seq = 0;
  connected = false;

  path: string | undefined;

  peerId: string | undefined;
  handshakeRole: HandshakeRole | undefined;
  private poller: NodeJS.Timeout | undefined;
  private pollerActive: boolean;
  private responsibleFiles: Set<string>;
  private lastSentFile: string | undefined;
  private consecutiveEnoentCount = 0;
  // An `error` emitted while no listener is registered is held here so the
  // next protocol-layer receive can detect failures that arrived in the gap
  // between listener-registration cycles. Reading clears the value; only the
  // most recent unhandled error is retained, since a subsequent error would
  // supersede the first as the proximate cause.
  private bufferedError: unknown;

  constructor(client: FileTransportClient, options?: Partial<Options>) {
    super();
    this.client = client;
    this.id = uuidv4();
    this.role = "unknown role";
    this.pollerActive = false;
    this.responsibleFiles = new Set();

    this.options = { ...getDefaultOptions(), ...options } as Options;
    this.log = getLoggerForVerbosity(
      `filesync-${this.id.substring(0, 8)}`,
      this.options.verbose,
    );
  }

  // Override emit so that an error fired with no listener is retained rather
  // than dropped. EventEmitter3 silently discards unhandled errors (unlike
  // Node's EventEmitter, which throws); buffering them lets the next
  // protocol-layer receive observe failures that occurred in the gap between
  // listener-registration cycles. `eventNames()` returns the events that
  // currently have listeners; an error-with-no-listener has the event absent.
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      // Only the most recent unhandled error is retained because a subsequent
      // error usually supersedes the first as the proximate cause. Surface a
      // log line when this happens so a chained failure is not invisible.
      // When both the prior and new errors are Error instances and the new
      // one has no `cause` set, chain the prior error as its cause so
      // downstream diagnostic output (e.g. an "Error: ... { cause: ... }"
      // formatter) can still surface the earlier failure rather than losing
      // it entirely. Mutation is gated on `cause === undefined` so we never
      // overwrite a cause the caller already set, and on `incoming !==
      // bufferedError` so a re-emit of the same Error reference cannot create
      // a self-referential cause chain that loops a downstream walker.
      const incoming = args[0];
      if (this.bufferedError !== undefined) {
        this.log.warn(
          `[${this.role}] superseding earlier buffered error: ` +
            errMessage(this.bufferedError),
        );
        if (
          incoming instanceof Error &&
          incoming.cause === undefined &&
          incoming !== this.bufferedError
        ) {
          try {
            incoming.cause = this.bufferedError;
          } catch {
            /* error object is frozen; chain is best-effort. */
          }
        }
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  /** Opens a connection from a typed config. Dispatches on `config.channel`. */
  async open(
    config: SFTPConnectionConfig | FileDropConnectionConfig,
  ): Promise<void> {
    if (config.options?.pollIntervalMs !== undefined)
      this.options.pollingFrequency = config.options.pollIntervalMs;
    if (config.options?.timestampInFilename !== undefined)
      this.options.timestampInFilename = config.options.timestampInFilename;
    // timeToLive is computed after a successful connect (below) so that
    // retry latency during connection setup does not eat into the
    // peer-waiting budget. Applies to both peerTimeoutMs-supplied and
    // default-fallback windows.

    if (config.channel === "filedrop") {
      // Normalize backslashes to forward slashes so ${this.path}/${name}
      // constructions work on Windows (fs accepts forward slashes there).
      const normalized = config.path.replace(/\\/g, "/");
      // Strip trailing slashes but preserve root-like paths: Unix "/" stays
      // "/", Windows drive root "C:/" stays "C:/" (stripped form "C:" is not
      // a valid path argument on Windows).
      const stripped = normalized.replace(/\/+$/, "");
      const dirPath = /^[A-Za-z]:$/.test(stripped)
        ? stripped + "/"
        : stripped || "/";
      this.log.debug(`[${this.role}] opening local path ${dirPath}`);
      await this.client.connect({
        path: dirPath,
        connectTimeoutMs: config.options?.serverConnectTimeoutMs,
        maxReconnectAttempts: config.options?.maxReconnectAttempts ?? 3,
      });
      this.path = dirPath;
    } else {
      this.path = config.server.path ?? "";
      if (this.path.endsWith("/")) this.path = this.path.slice(0, -1);

      const connectOptions: Record<string, unknown> = {
        host: config.server.host,
        maxReconnectAttempts: config.options?.maxReconnectAttempts ?? 3,
      };
      if (config.server.port !== undefined)
        connectOptions["port"] = config.server.port;
      if (config.server.username !== undefined)
        connectOptions["username"] = config.server.username;
      if (config.server.password !== undefined)
        connectOptions["password"] = config.server.password;
      if (config.server.privateKey !== undefined)
        connectOptions["privateKey"] = config.server.privateKey;
      if (config.server.privateKeyPassphrase !== undefined)
        connectOptions["passphrase"] = config.server.privateKeyPassphrase;
      // serverConnectTimeoutMs for SFTP is enforced by ssh2 via readyTimeout,
      // not a Promise.race wrapper — the per-attempt deadline is equivalent.
      if (config.options?.serverConnectTimeoutMs !== undefined)
        connectOptions["readyTimeout"] = config.options.serverConnectTimeoutMs;
      // providerOptions are spread last so they can override any of the above.
      // certificate, hostKeyFingerprint, and knownHosts also belong here.
      if (config.providerOptions !== undefined)
        Object.assign(connectOptions, config.providerOptions);

      const portString =
        config.server.port !== undefined ? `:${config.server.port}` : "";
      const usernameString =
        config.server.username !== undefined
          ? ` as ${config.server.username}`
          : "";
      this.log.debug(
        `[${this.role}] connecting to ${config.server.host}` +
          `${portString}${usernameString}, path: ${this.path}`,
      );
      await this.client.connect(connectOptions);
    }

    this.connected = true;
    // Compute timeToLive only after connect() has resolved so that retry
    // latency during connection setup does not eat into the peer-waiting
    // budget. Three cases:
    //   1. No constructor timeToLive, no config peerTimeoutMs: use the default
    //      budget for both timeToLive and peerTimeoutMs.
    //   2. No constructor timeToLive, config peerTimeoutMs present: derive
    //      timeToLive from config peerTimeoutMs and store the raw duration.
    //   3. Constructor timeToLive present: it wins - do not recompute timeToLive.
    //      Still store config peerTimeoutMs when provided so close() can use a
    //      fresh drain deadline independent of the exchange duration.
    if (this.options.timeToLive === undefined) {
      const ttlMs = config.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
      this.options.peerTimeoutMs = ttlMs;
      this.options.timeToLive = new Date(Date.now() + ttlMs);
    } else if (config.options?.peerTimeoutMs !== undefined) {
      this.options.peerTimeoutMs = config.options.peerTimeoutMs;
    }
    this.log.debug(`[${this.role}] connected`);
  }

  async cleanup() {
    const responsibleFilesString =
      this.responsibleFiles.size > 0
        ? `: ${[...this.responsibleFiles].join(", ")}`
        : "";
    this.log.debug(
      `[${this.role}] cleaning up ${this.responsibleFiles.size} file(s)` +
        `${responsibleFilesString}`,
    );
    return Promise.all(
      Array.from(this.responsibleFiles).map((filename) =>
        this.client.safeDelete(`${this.path}/${filename}`),
      ),
    );
  }

  /**
   * Tears the connection down in full: stops the poll loop, sweeps the files
   * this side is responsible for, then ends the underlying client. Ordering is
   * load-bearing - the poller must stop before the client is ended (or its next
   * cycle would run against a dead client and emit a spurious error), and
   * cleanup must run before the client is ended (it deletes remote files
   * through that client).
   *
   * Before cleanup, drains the last sent file: waits for the peer to consume
   * it so a clean close never deletes an unconsumed terminal frame. The wait is
   * bounded by a fresh {@link Options.peerTimeoutMs} budget from close() start
   * (not the remaining timeToLive, which may be near-zero for long exchanges).
   * An unresponsive peer causes the drain to time out and cleanup() to delete
   * the file as a fallback. Idempotent: safe to call repeatedly and on a
   * connection that was never opened.
   */
  async close() {
    this.stop();

    if (this.path !== undefined) {
      // Drain the last sent file before sweeping: a clean close must not
      // delete a terminal frame the peer has not yet consumed. Uses a fresh
      // peerTimeoutMs budget from close() start so a long exchange does not
      // leave the budget near-zero for teardown. Drain failure (list() error
      // or timeout) falls through to cleanup(), which deletes as a fallback.
      if (this.lastSentFile !== undefined) {
        const path = this.path;
        const lastSentFile = this.lastSentFile;
        const deadline =
          Date.now() +
          (this.options.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS);
        const filePresent = async () =>
          (await this.client.list(path)).some((f) => f.name === lastSentFile);
        try {
          if (await filePresent()) {
            this.log.debug(
              `[${this.role}] draining ${lastSentFile} before cleanup`,
            );
            while (Date.now() < deadline && (await filePresent())) {
              await new Promise((resolve) =>
                setTimeout(resolve, this.options.pollingFrequency),
              );
            }
          }
        } catch {
          // list() failure during drain; fall through to cleanup.
        }
      }

      // Best-effort sweep: a delete failure must not stop us from ending the
      // client, so it is logged rather than propagated.
      try {
        await this.cleanup();
      } catch (err: unknown) {
        this.log.debug(
          `[${this.role}] cleanup during close: ${errMessage(err)}`,
        );
      }
    }

    if (this.connected) {
      this.log.debug(`[${this.role}] closing connection`);
      await this.client.end();
      this.connected = false;
    }
    this.path = undefined;
  }

  /**
   * Negotiates rendezvous with the peer by exchanging `.hello` and `.wave`
   * files in the shared directory, assigning `peerId` and `handshakeRole` on
   * success.
   *
   * Failures throw synchronously rather than being emitted on the `error`
   * channel: the `error` event is reserved for asynchronous failures from the
   * poll loop (see {@link start}), which can occur at any time. Callers must
   * await this method and catch its rejection; an attached `on("error", ...)`
   * listener will not observe a synchronize-time failure.
   */
  async synchronize() {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (this.peerId) throw new Error("already synchronized");

    this.log.info(`[${this.role}] synchronizing at path ${this.path}`);

    let files: Array<FileInfo>;
    try {
      files = await this.client.list(this.path);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    this.log.trace(
      `[${this.role}] found ${files.length} file(s)` +
        `${files.length > 0 ? `: ${fileNames.join(", ")}` : ""}`,
    );
    this.responsibleFiles.forEach((fileName) => {
      if (!fileNames.includes(fileName)) this.responsibleFiles.delete(fileName);
    });
    const helloFiles = files.filter((file) => file.name.endsWith(".hello"));

    if (
      helloFiles.length > 1 ||
      files.some((file) => file.name.endsWith(".wave"))
    ) {
      const leftover = files
        .filter((f) => f.name.endsWith(".hello") || f.name.endsWith(".wave"))
        .map((f) => f.name)
        .join(", ");
      throw new Error(
        `path ${this.path} had preexisting hello or wave files ` +
          `(${leftover}); the directory must be empty of .hello and .wave ` +
          "files before executing the protocol. Most likely cause: a " +
          "previous exchange was terminated by SIGKILL/OOM/power loss " +
          "before its cleanup ran. Remove the listed files manually after " +
          "verifying that no other session is concurrently using this path.",
      );
    }

    const helloPath = `${this.path}/${this.id}.hello`;

    if (helloFiles.length === 1) {
      /**
       * A list
       * A hello
       * B list
       * B delete A hello
       * B hello
       * A list
       * A delete B hello
       *
       * This is B.
       */

      const otherFile = helloFiles[0];
      const otherPath = `${this.path}/${otherFile.name}`;
      const peerId = otherFile.name.slice(0, -6);

      this.log.debug(
        `[joiner] creating response ${this.id}.hello and deleting ` +
          `discovered ${otherFile.name}`,
      );

      // Partial-failure note: if delete(otherPath) succeeds but put(helloPath)
      // fails, the peer's hello is gone and we never wrote our own. The peer's
      // waitForPeer loop will see an empty directory and poll until
      // peerTimeoutMs before reporting a synchronization timeout. Recovery is
      // by retry of the whole exchange. We do not re-create the peer's hello
      // here because doing so races the peer's next list() and can produce a
      // two-hello state the wave protocol treats as a collision.
      try {
        await this.client.delete(otherPath);

        await this.client.put(Buffer.from(new ArrayBuffer(0)), helloPath, {
          flags: "w",
          encoding: "utf-8",
        });
        this.responsibleFiles.add(`${this.id}.hello`);
      } catch (err: unknown) {
        throw err instanceof Error ? err : new Error(errMessage(err));
      }

      // Commit role and peerId only after both writes have succeeded. If
      // either write threw above, the connection stays in its
      // pre-synchronize state: `this.peerId` remains undefined, so the
      // "already synchronized" guard does not block a retry on the same
      // instance, and `handshakeRole` does not point at a peer that may
      // not actually exist.
      this.handshakeRole = "initiator";
      this.role = "joiner";
      this.peerId = peerId;
    } else {
      /**
       * Either
       *
       * A ~ B list
       * A ~ B hello
       * A list
       * A wave
       *
       * or
       *
       * A ~ B list
       * A ~ B hello
       * A ~ B list
       * A ~ B wave
       */

      this.log.debug(`[${this.role}] creating initial ${this.id}.hello`);
      await this.client.put(Buffer.from(new ArrayBuffer(0)), helloPath, {
        flags: "w",
        encoding: "utf-8",
      });
      this.responsibleFiles.add(`${this.id}.hello`);
      let wavePath: string | undefined;

      const waitForPeer = async () => {
        // open() set timeToLive before synchronize() can run, so the non-null
        // assertion is safe here.
        while (Date.now() <= this.options.timeToLive!.getTime()) {
          const currentFiles = await this.client.list(this.path!);

          const fileNames = currentFiles.map((file) => file.name);
          this.responsibleFiles.forEach((fileName) => {
            if (!fileNames.includes(fileName))
              this.responsibleFiles.delete(fileName);
          });

          const otherFiles = currentFiles.filter(
            (file) =>
              file.name !== `${this.id}.hello` && file.name.endsWith(".hello"),
          );
          const theseFiles = currentFiles.filter(
            (file) => file.name === `${this.id}.hello`,
          );
          const waveFiles = currentFiles.filter((file) =>
            file.name.endsWith(".wave"),
          );

          if (otherFiles.length === 0) {
            this.log.trace(`[${this.role}] no peer hello found; polling`);
            const delay = (ms: number) =>
              new Promise((resolve) => setTimeout(resolve, ms));
            await delay(this.options.pollingFrequency);
            continue;
          }

          if (waveFiles.length > 0) {
            /**
             * A ~ B list
             * A ~ B hello
             * A list
             * A wave
             * B list
             * B delete A hello, B hello, wave
             *
             * This is B
             */
            if (waveFiles.length > 1) {
              throw new Error(
                "more than one wave file - are there other sessions using " +
                  "this path?",
                { cause: "usage" },
              );
            }
            if (otherFiles.length !== 1) {
              throw new Error(
                "wave file detected but no peer hello - are there other " +
                  "sessions using this path?",
                { cause: "usage" },
              );
            }
            if (theseFiles.length !== 1) {
              throw new Error(
                "wave file detected but no self hello - are there other " +
                  "sessions using this path?",
                { cause: "usage" },
              );
            }

            const waveFile = waveFiles[0];
            const otherFile = otherFiles[0];
            const thisFile = theseFiles[0];

            const waveRegex = new RegExp(
              [
                /^/,
                /([0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12})/,
                /-/,
                /([0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12})/,
                /\.wave/,
                /$/,
              ]
                .map((r) => r.source)
                .join(""),
              "i",
            );
            const waveMatches = waveFile.name.match(waveRegex);
            if (!waveMatches || waveMatches.length !== 3)
              throw new Error("wave file name not in expected format");
            // The two capture groups are bare UUIDs, but theseFiles /
            // otherFiles entries carry the ".hello" suffix; strip it before
            // comparing so the cross-checks can succeed.
            const thisId = thisFile.name.slice(0, -".hello".length);
            const otherId = otherFile.name.slice(0, -".hello".length);
            if (waveMatches[1] !== thisId && waveMatches[2] !== thisId)
              throw new Error("wave file does not reference this connection");
            if (waveMatches[1] !== otherId && waveMatches[2] !== otherId)
              throw new Error("wave file does not reference other connection");

            // first to arrive => should wait for first message
            this.handshakeRole =
              waveMatches[1] === this.id ? "responder" : "initiator";
            this.role =
              this.handshakeRole === "initiator" ? "joiner" : "starter";
            this.peerId = otherFile.name.slice(0, -6);

            this.log.debug(`[${this.role}] parsed ${waveFile.name}`);

            await this.client.safeDelete(`${this.path}/${waveFile.name}`);
            await this.client.safeDelete(`${this.path}/${otherFile.name}`);
            await this.client.safeDelete(helloPath);

            this.responsibleFiles.clear();

            return;
          }

          if (otherFiles.length > 1) {
            throw new Error(
              `more than one peer hello file in ${this.path} - are there ` +
                "other sessions using this path?",
              { cause: "usage" },
            );
          }
          const otherFile = otherFiles[0];
          if (theseFiles.length === 0) {
            /**
             * A list
             * A hello
             * B list
             * B delete A hello
             * B hello
             * A delete B hello
             *
             * This is A
             */
            const otherPath = `${this.path}/${otherFile.name}`;

            // arrived first, should wait for a message
            this.handshakeRole = "responder";
            this.role = "starter";
            this.peerId = otherFile.name.slice(0, -6);

            this.log.debug(
              `[${this.role}] detected ${otherFile.name}; deleting it`,
            );

            await this.client.safeDelete(otherPath);

            this.responsibleFiles.clear();

            return;
          } else {
            if (theseFiles.length > 1) {
              throw new Error(
                `more than one self hello file in ${this.path} - are there ` +
                  "other sessions using this path?",
                { cause: "usage" },
              );
            }

            const thisFile = theseFiles[0];

            // Tiebreak on UUID lexicographic order alone, never modifyTime:
            // both hello UUIDs are identical on each side, so this comparison
            // is deterministic and symmetric regardless of which party runs
            // it. modifyTime is unreliable here -- sync tools stamp files with
            // the transfer time rather than the original creation time, so the
            // two parties may observe different (even contradictory) timestamps
            // for the same files.
            const arrivedFirst = thisFile.name < otherFile.name;
            this.handshakeRole = arrivedFirst ? "responder" : "initiator";
            this.role = arrivedFirst ? "starter" : "joiner";
            this.peerId = otherFile.name.slice(0, -6);

            const waveName =
              `${arrivedFirst ? this.id : this.peerId}-` +
              `${arrivedFirst ? this.peerId : this.id}.wave`;
            wavePath = `${this.path}/${waveName}`;

            this.log.debug(`[${this.role}] attempting to create ${waveName}`);

            // Pre-emptively track waveName: if createExclusive only partially
            // succeeds (file created on server but handle-close fails with a
            // non-EEXIST error), cleanup() will still attempt safeDelete even
            // though the EEXIST handler's responsibleFiles.clear() is never
            // reached. Both EEXIST branches below call responsibleFiles.clear(),
            // which also removes this pre-emptive entry.
            this.responsibleFiles.add(waveName);
            try {
              await this.client.createExclusive(wavePath);
              this.log.debug(
                `[${this.role}] created wave file ${waveName}; waiting for ` +
                  "peer to finalize handshake",
              );

              /**
               * A ~ B list
               * A ~ B hello
               * A ~ list
               * A ~ createExclusive wave
               * ...
               *
               * This is A
               */
            } catch (err: unknown) {
              /**
               * A ~ B list
               * A ~ B hello
               * A ~ B list
               * A createExclusive wave
               * B createExclusive wave, EEXIST
               * B delete A hello, B hello, wave
               *
               * This is B
               */
              if (
                !(err instanceof Error) ||
                (err as NodeJS.ErrnoException).code !== "EEXIST"
              )
                throw err;

              const waveAlreadyExists = await this.client.exists(wavePath);

              if (!waveAlreadyExists) {
                // The winner never deletes the wave file in its normal path
                // (it returns from waitForPeer leaving the wave for the loser
                // to clean up). If the wave is gone after we received EEXIST,
                // the winner must have either crashed (their doCleanup ran
                // during the narrow window where waveName was in
                // responsibleFiles) or otherwise abandoned the handshake.
                // Either way, polling for their first protocol message would
                // stall until peerTimeoutMs. Fail fast with a clear cause so
                // the user does not wait for a peer that is not coming.
                // Best-effort tidy of both hellos before throwing so the
                // directory is left clean for a retry.
                await this.client.safeDelete(`${this.path}/${otherFile.name}`);
                await this.client.safeDelete(helloPath);
                this.responsibleFiles.clear();
                throw new Error(
                  "peer appears to have abandoned the handshake: wave file " +
                    "was claimed by the peer but disappeared before this " +
                    "side could complete synchronization. Retry the exchange.",
                  { cause: "usage" },
                );
              } else {
                this.log.debug(
                  `[${this.role}] wave file creation failed, assuming race ` +
                    "condition",
                );

                await this.client.safeDelete(wavePath);
                await this.client.safeDelete(`${this.path}/${otherFile.name}`);
                await this.client.safeDelete(helloPath);

                this.responsibleFiles.clear();
              }
            }
            return;
          }
        }

        throw new Error(`[${this.role}] synchronization has timed out`);
      };
      try {
        await waitForPeer();
        // No clear() here: branches that finish their own cleanup
        // (responder, wave-detection, EEXIST loser) clear explicitly
        // before returning. The createExclusive-winner path is the
        // exception — it leaves `${this.id}.hello` and waveName in
        // responsibleFiles so the eventual cleanup() can sweep them
        // if the loser never arrives (e.g. crash before reaching the
        // wave file). Clearing here would lose that safety net.
        return;
      } catch (err: unknown) {
        if (wavePath) await this.client.safeDelete(wavePath);
        await this.client.safeDelete(helloPath);
        this.responsibleFiles.clear();
        if (err instanceof Error && err.cause === "usage") delete err.cause;
        throw err instanceof Error ? err : new Error(errMessage(err));
      }
    }
  }

  /**
   * Writes one message to the shared directory for the peer to consume.
   *
   * Failures throw synchronously rather than being emitted on the `error`
   * channel: the `error` event is reserved for asynchronous failures from the
   * poll loop (see {@link start}). Callers must await this method and catch
   * its rejection; an attached `on("error", ...)` listener will not observe
   * a send-time failure.
   */
  async send(data: unknown) {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    const path = this.path;
    // A `.tmp` extension (not `.json`) keeps this in-flight write from matching
    // a `*.json` sync-tool watch before the rename to the final name lands.
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = `${path}/${tempFile}`;

    // Each message carries a distinct filename (the byte count, and optionally
    // a counter, differ per send), so a previous message the peer has not yet
    // consumed cannot be found by an exact name. Scan for any `<id>-*.json` we
    // still own and wait for it to clear, preserving the one-outstanding-
    // message-at-a-time invariant the peer's poll() relies on.
    const hasOutstandingMessage = async () =>
      (await this.client.list(path)).some(
        (file) =>
          file.name.startsWith(`${this.id}-`) && file.name.endsWith(".json"),
      );

    try {
      if (await hasOutstandingMessage()) {
        this.log.debug(
          `[${this.role}] waiting for previous message to be consumed`,
        );
        while (await hasOutstandingMessage()) {
          // open() set timeToLive before send() can run; assertion is safe.
          if (Date.now() > this.options.timeToLive!.getTime()) {
            throw new Error(
              `timed out waiting for message from ${this.id} to be consumed`,
              { cause: "usage" },
            );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.pollingFrequency),
          );
        }
      }

      let type = "Object";
      if (data instanceof Uint8Array) {
        data = Buffer.from(data).toString("base64");
        type = "Uint8Array";
      }

      const ts = Date.now();
      const seq = this.seq++;
      // Serialize before constructing the filename so the encoded byte count is
      // the exact on-disk size; the peer waits until the synced file reaches
      // that many bytes before reading it, so a partial sync delivery is never
      // read as a complete message.
      const payload = Buffer.from(
        JSON.stringify({ ts, seq, type, payload: data }),
      );
      const outName = this.messageFilename(payload.byteLength, seq, ts);
      const outPath = `${path}/${outName}`;

      this.log.trace(
        `[${this.role}] message seq=${seq}, type=${type}, ` +
          `${payload.byteLength} bytes`,
      );
      this.log.debug(`[${this.role}] writing message ${tempFile}`);
      await this.client.put(payload, tempPath, {
        flags: "w",
        encoding: null,
      });

      this.log.debug(`[${this.role}] renaming ${tempFile} to ${outName}`);
      await this.client.rename(tempPath, outPath);
      this.responsibleFiles.add(outName);
      this.lastSentFile = outName;
    } catch (err: unknown) {
      await this.client.safeDelete(tempPath);
      if (err instanceof Error && err.cause === "usage") delete err.cause;
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
  }

  // Builds an outgoing message filename. The byte count is always the final
  // `-`-delimited segment before `.json` so the receiver can extract it with a
  // right-anchored parse (see parseMessageByteCount). When timestampInFilename
  // is set, a compact UTC timestamp and a zero-padded per-session counter are
  // inserted so sync-mediated logging can recover write order even when the
  // sync tool rewrites file mtimes.
  private messageFilename(byteCount: number, seq: number, ts: number): string {
    if (!this.options.timestampInFilename)
      return `${this.id}-${byteCount}.json`;
    // YYYYMMDDTHHMMSS in UTC: no colons or hyphens, so it is Windows-safe,
    // lexicographically time-sortable, and occupies one hyphen-delimited
    // segment.
    const timestamp = new Date(ts)
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15);
    // Zero-padded to three digits for the common case; widens to four or more
    // past message 999, which keeps names unique (the byte count is still the
    // final segment) at the cost of strict three-digit width on long sessions.
    const counter = String(seq).padStart(3, "0");
    return `${this.id}-${timestamp}-${counter}-${byteCount}.json`;
  }

  private async poll() {
    if (!this.pollerActive) return;

    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (!this.peerId) throw new Error("not synchronized");

    const path = this.path;
    const peerId = this.peerId;

    let reachedGet = false;
    try {
      this.log.trace(`[${this.role}] polling for message from ${peerId}`);
      // Detect via a pattern scan rather than an exact-name exists(): the
      // message filename now encodes a per-message byte count (and optionally
      // a timestamp and counter), so the receiver cannot predict the exact
      // name. `<peerId>-*.json` matches only the peer's message files - its
      // `.hello`/`.wave` handshake files and our own `<id>-*.json` writes are
      // excluded by prefix or extension.
      //
      // A name that matches the prefix but whose final segment is not a byte
      // count (e.g. a leftover `<peerId>-backup.json`) is ignored, not treated
      // as an error: the previous exact-name lookup never matched such a file,
      // so failing the exchange over an unrelated file would be a regression.
      const messages: Array<{ file: FileInfo; declaredSize: number }> = [];
      const ignored: string[] = [];
      for (const file of await this.client.list(path)) {
        if (!file.name.startsWith(`${peerId}-`) || !file.name.endsWith(".json"))
          continue;
        const declaredSize = parseMessageByteCount(file.name);
        if (declaredSize === undefined) ignored.push(file.name);
        else messages.push({ file, declaredSize });
      }
      if (ignored.length > 0)
        this.log.trace(
          `[${this.role}] ignoring ${ignored.length} non-message file(s) ` +
            `matching ${peerId}-*.json: ${ignored.join(", ")}`,
        );

      if (messages.length > 1) {
        // Emitted (not thrown to a caller), so no "usage" sentinel: the bridge
        // classifies every poll-loop error as a transport failure.
        throw new Error(
          `more than one message file from ${peerId} in ${path} - are there ` +
            "other sessions using this path?",
        );
      }

      if (messages.length === 1) {
        const { file: messageFile, declaredSize } = messages[0];

        if (messageFile.size < declaredSize) {
          // The file has appeared but the sync tool has not finished
          // transferring it. Leave it untouched and re-check next cycle rather
          // than reading a truncated message. For a direct transport (SFTP),
          // the atomic rename means the size already matches on the first poll.
          this.log.trace(
            `[${this.role}] ${messageFile.name} is ${messageFile.size}/` +
              `${declaredSize} bytes; waiting for full sync`,
          );
        } else {
          const inPath = `${path}/${messageFile.name}`;
          this.log.debug(`[${this.role}] getting message ${messageFile.name}`);

          reachedGet = true;
          const message = await this.client.get(inPath, { encoding: "utf-8" });
          reachedGet = false;

          this.log.debug(`[${this.role}] deleting message ${messageFile.name}`);
          try {
            await this.client.delete(inPath);
          } catch {
            await new Promise((resolve) =>
              setTimeout(resolve, this.options.pollingFrequency),
            );
            try {
              await this.client.delete(inPath);
            } catch (deleteErr: unknown) {
              this.log.warn(
                `[${this.role}] failed to delete ${messageFile.name}; ` +
                  "please notify the administrator that manual cleanup " +
                  `may be required: ${errMessage(deleteErr)}`,
              );
            }
          }

          const validatedMessage = Message.parse(
            JSON.parse(message.toString()),
          );
          this.log.trace(
            `[${this.role}] received message seq=${validatedMessage.seq}, ` +
              `type=${validatedMessage.type}`,
          );

          if (validatedMessage.type === "Uint8Array") {
            const bytes = Buffer.from(
              validatedMessage.payload as string,
              "base64",
            );
            this.emit("data", bytes);
          } else {
            this.emit("data", validatedMessage.payload);
          }
        }
      }
      this.consecutiveEnoentCount = 0;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && reachedGet) {
        // TOCTOU race: list() surfaced the file but get() found it gone,
        // meaning the peer cleaned up between the two calls. After a single
        // race the file is genuinely gone and subsequent list() cycles no
        // longer match it, resetting the counter on the next clean poll.
        // Consecutive ENOENTs that keep incrementing the counter indicate a
        // pathological filesystem state that will not self-resolve; emit an
        // error after MAX_CONSECUTIVE_ENOENT rather than looping silently
        // until the peer timeout fires.
        if (++this.consecutiveEnoentCount >= MAX_CONSECUTIVE_ENOENT) {
          // Stop the poller synchronously before emitting so that the
          // finally block does not reschedule another poll. The external
          // error handler (doCleanup → conn.stop()) is still called and
          // is safe when pollerActive is already false.
          this.pollerActive = false;
          this.emit(
            "error",
            err instanceof Error ? err : new Error(errMessage(err)),
          );
        } else {
          this.log.warn(
            `[${this.role}] message from ${peerId} disappeared between list ` +
              "and get; assuming peer cleaned up",
          );
        }
      } else {
        // Non-TOCTOU failure: either a non-ENOENT error from any operation, or
        // any error where reachedGet is false (e.g., exists() or message
        // parsing). Note: delete() errors cannot reach here — delete() has its
        // own inner try/catch (see above) that handles and swallows them.
        // All cases are propagated immediately as hard failures.
        this.consecutiveEnoentCount = 0;
        this.emit(
          "error",
          err instanceof Error ? err : new Error(errMessage(err)),
        );
      }
    } finally {
      if (this.pollerActive) {
        this.poller = setTimeout(
          () => this.poll(),
          this.options.pollingFrequency,
        );
      }
    }
  }

  start() {
    this.log.debug(`[${this.role}] starting poller`);
    this.pollerActive = true;
    this.consecutiveEnoentCount = 0;
    this.poll();
  }

  stop() {
    this.log.debug(`[${this.role}] stopping poller`);
    this.pollerActive = false;
    if (this.poller) clearTimeout(this.poller);
  }
}
