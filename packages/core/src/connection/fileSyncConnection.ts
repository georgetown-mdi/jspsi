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

/** 1 hour */
const DEFAULT_TIME_TO_LIVE_MS = 1000 * 60 * 60;
const DEFAULT_POLLING_FREQUENCY_MS = 100;
const DEFAULT_VERBOSITY = 1;

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

interface Options {
  timeToLive: Date;
  pollingFrequency: number;
  verbose: number;
}

const Message = z.object({
  ts: z.number().nonnegative(),
  seq: z.number().nonnegative(),
  type: z.literal(["Object", "Uint8Array"]),
  payload: z.json(),
});

const getDefaultOptions = (): Options => {
  return {
    timeToLive: new Date(Date.now() + DEFAULT_TIME_TO_LIVE_MS),
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY,
  };
};

export interface FileInfo {
  name: string;
  modifyTime: number;
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

  /** Opens a connection from a typed config. Dispatches on `config.channel`. */
  async open(
    config: SFTPConnectionConfig | FileDropConnectionConfig,
  ): Promise<void> {
    if (config.options?.pollIntervalMs !== undefined)
      this.options.pollingFrequency = config.options.pollIntervalMs;
    // timeToLive is set after a successful connect so the full peerTimeoutMs
    // budget is available for peer-waiting rather than being eaten by retries.

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
    if (config.options?.peerTimeoutMs !== undefined)
      this.options.timeToLive = new Date(
        Date.now() + config.options.peerTimeoutMs,
      );
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

  async close() {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    this.log.debug(`[${this.role}] closing connection`);
    const result = await this.client.end();
    this.connected = false;
    this.path = undefined;
    return result;
  }

  async synchronize() {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (this.peerId) throw new Error("already synchronized");

    this.log.info(`[${this.role}] synchronizing at path ${this.path}`);

    let files: Array<FileInfo>;
    try {
      files = await this.client.list(this.path);
    } catch (err: unknown) {
      this.emit("error", errMessage(err));
      return;
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
      throw new Error(
        `path ${this.path} had preexisting hello or wave files; must be ` +
          "empty to execute protocol",
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

      // arrived second, and so should send the first message
      this.handshakeRole = "initiator";
      this.role = "joiner";
      this.peerId = otherFile.name.slice(0, -6);

      this.log.debug(
        `[${this.role}] creating response ${this.id}.hello and deleting ` +
          `discovered ${otherFile.name}`,
      );

      try {
        await this.client.delete(otherPath);

        await this.client.put(Buffer.from(new ArrayBuffer(0)), helloPath, {
          flags: "w",
          encoding: "utf-8",
        });
        this.responsibleFiles.add(`${this.id}.hello`);
      } catch (err: unknown) {
        this.emit("error", errMessage(err));
        return;
      }
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
        while (Date.now() <= this.options.timeToLive.getTime()) {
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
                /.wave/,
                /$/,
              ]
                .map((r) => r.source)
                .join(""),
              "i",
            );
            const waveMatches = waveFile.name.match(waveRegex);
            if (!waveMatches || waveMatches.length !== 3)
              throw new Error("wave file name not in expected format");
            if (!waveMatches.some((x) => x === thisFile.name))
              throw new Error("wave file does not reference this connection");
            if (!waveMatches.some((x) => x === otherFile.name))
              throw new Error("wave file does not reference other connection");

            // first to arrive => should wait for first message
            this.handshakeRole =
              waveMatches[1] === this.id ? "responder" : "initiator";
            this.role =
              this.handshakeRole === "initiator" ? "starter" : "joiner";
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

            const arrivedFirst =
              thisFile.modifyTime < otherFile.modifyTime ||
              (thisFile.modifyTime === otherFile.modifyTime &&
                thisFile.name < otherFile.name);
            this.handshakeRole = arrivedFirst ? "responder" : "initiator";
            this.role = arrivedFirst ? "starter" : "joiner";
            this.peerId = otherFile.name.slice(0, -6);

            const waveName =
              `${arrivedFirst ? this.id : this.peerId}-` +
              `${arrivedFirst ? this.peerId : this.id}.wave`;
            wavePath = `${this.path}/${waveName}`;
            const tempPath = `${this.path}/${this.id}.tmp.wave`;

            this.log.debug(`[${this.role}] attempting to create ${waveName}`);
            await this.client.put(Buffer.from(new ArrayBuffer(0)), tempPath, {
              flags: "w",
              encoding: "utf-8",
            });
            this.responsibleFiles.add(`${this.id}.tmp.wave`);

            try {
              await this.client.rename(tempPath, wavePath);
              this.responsibleFiles.add(waveName);
              this.responsibleFiles.delete(`${this.id}.tmp.wave`);
              this.log.debug(
                `[${this.role}] created wave file ${waveName}; waiting for ` +
                  "peer to finalize handshake",
              );

              /**
               * A ~ B list
               * A ~ B hello
               * A ~ list
               * A ~ wave
               * ...
               *
               * This is A
               */
            } catch (err: unknown) {
              /**
               * A ~ B list
               * A ~ B hello
               * A ~ B list
               * A wave
               * B try to wave, fail
               * B delete A hello, B hello, wave
               *
               * This is B
               */
              await this.client.safeDelete(tempPath);
              const waveAlreadyExists = await this.client.exists(wavePath);

              if (!(err instanceof Error) || !waveAlreadyExists) throw err;

              this.log.debug(
                `[${this.role}] wave file creation failed, assuming race ` +
                  "condition",
              );

              await this.client.safeDelete(wavePath);
              await this.client.safeDelete(`${this.path}/${otherFile.name}`);
              await this.client.safeDelete(helloPath);

              this.responsibleFiles.clear();
            }
            return;
          }
        }

        throw new Error(`[${this.role}] synchronization has timed out`);
      };
      try {
        await waitForPeer();
        this.responsibleFiles.clear();
        return;
      } catch (err: unknown) {
        if (wavePath) await this.client.safeDelete(wavePath);
        await this.client.safeDelete(helloPath);
        if (err instanceof Error && err.cause === "usage") {
          delete err.cause;
          throw err;
        }

        this.emit("error", errMessage(err));
      }
    }
  }

  async send(data: unknown) {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    const outPath = `${this.path}/${this.id}.json`;
    const tempFile = `temp-${uuidv4()}.json`;
    const tempPath = `${this.path}/${tempFile}`;

    try {
      if (await this.client.exists(outPath)) {
        this.log.debug(
          `[${this.role}] waiting for previous message to be consumed`,
        );
        while (await this.client.exists(outPath)) {
          if (Date.now() > this.options.timeToLive.getTime()) {
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

      const message = JSON.stringify({
        ts: Date.now(),
        seq: this.seq++,
        type,
        payload: data,
      });
      this.log.trace(
        `[${this.role}] message seq=${this.seq - 1}, type=${type}, ` +
          `${message.length} bytes`,
      );
      this.log.debug(`[${this.role}] writing message ${tempFile}`);
      await this.client.put(Buffer.from(message), tempPath, {
        flags: "w",
        encoding: null,
      });

      this.log.debug(`[${this.role}] renaming ${tempFile} to ${this.id}.json`);
      await this.client.rename(tempPath, outPath);
      this.responsibleFiles.add(`${this.id}.json`);
    } catch (err: unknown) {
      await this.client.safeDelete(tempPath);
      if (err instanceof Error && err.cause === "usage") {
        delete err.cause;
        throw err;
      }
      this.emit("error", errMessage(err));
    }
  }

  private async poll() {
    if (!this.pollerActive) return;

    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (!this.peerId) throw new Error("not synchronized");

    const inPath = `${this.path}/${this.peerId}.json`;

    try {
      this.log.trace(`[${this.role}] polling for message from ${this.peerId}`);
      const messageFile = await this.client.exists(inPath);
      if (messageFile) {
        this.log.debug(
          `[${this.role}] getting message from ${this.peerId}.json`,
        );

        const message = await this.client.get(inPath, { encoding: "utf-8" });

        this.log.debug(`[${this.role}] deleting message ${this.peerId}.json`);
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
              `[${this.role}] failed to delete ${this.peerId}.json; ` +
                "please notify the administrator that manual cleanup " +
                `may be required: ${errMessage(deleteErr)}`,
            );
          }
        }

        const validatedMessage = Message.parse(JSON.parse(message.toString()));
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
    } catch (err: unknown) {
      this.emit("error", errMessage(err));
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
    this.poll();
  }

  stop() {
    this.log.debug(`[${this.role}] stopping poller`);
    this.pollerActive = false;
    if (this.poller) clearTimeout(this.poller);
  }
}
