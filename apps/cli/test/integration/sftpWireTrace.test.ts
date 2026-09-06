import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import logLibrary from "loglevel";
import ssh2 from "ssh2";
import { describe, expect, test, vi } from "vitest";
import { setLogLevel } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { probeHostKeyLines } from "../../src/commands/probeHostKey";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { SSH_WIRE_TRACE_LOGGER_NAME } from "../../src/connection/sftpWireTrace";
import { configureLogging } from "../../src/util/logging";
import { serverAuth, sftpServer } from "../sftpServer/testContext";

// What a dial reports about its own SSH handshake, driven against the real
// stack rather than modeled from ssh2's callback contract (CLAUDE.md,
// settle-by-driving-the-tool). Five things are held here: that `--log-level
// trace` alone answers "did the handshake complete, and on what" from one run;
// that no credential the dial sends is among what it reports; that every level
// below trace emits not one line of it, whatever the `-v` count; that a
// peer's own bytes reach the operator escaped, since a name-list the peer chose
// arrives verbatim from ssh2 (docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP
// Stack"); and that the lines the stack renders as the transport drains reach
// the operator's --log-file rather than the console it would fall through to
// once a command has closed its sink.

const TEST_TIMEOUT_MS = 60_000;
const DIAL_BUDGET_MS = 5_000;

/** One SSH name-list, length-prefixed as the wire format frames it. */
function nameList(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const framed = Buffer.alloc(4 + body.length);
  framed.writeUInt32BE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

/** One binary packet: the length, the padding byte, the payload, the padding. */
function packet(payload: Buffer): Buffer {
  let padding = 8 - ((payload.length + 5) % 8);
  if (padding < 4) padding += 8;
  const framed = Buffer.alloc(4 + 1 + payload.length + padding);
  framed.writeUInt32BE(1 + payload.length + padding, 0);
  framed[4] = padding;
  payload.copy(framed, 5);
  return framed;
}

/**
 * A listener that answers the SSH identification string and one KEXINIT of its
 * own choosing, so every pre-key-exchange byte the client renders is this
 * test's. Written on the wire rather than through ssh2's `Server`, which
 * accepts neither an identification string nor an algorithm name outside what
 * it can perform.
 */
function hostilePeer(
  ident: string,
  kexNameList: string,
): {
  port: Promise<number>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));

  const kexinit = (): Buffer => {
    // SSH_MSG_KEXINIT: the message number, a 16-byte cookie, the ten
    // name-lists, then the first-packet-follows flag and the reserved word.
    const head = Buffer.alloc(17);
    head[0] = 20;
    const lists = [
      kexNameList,
      "ssh-ed25519",
      "aes128-ctr",
      "aes128-ctr",
      "hmac-sha2-256",
      "hmac-sha2-256",
      "none",
      "none",
      "",
      "",
    ].map(nameList);
    return Buffer.concat([head, ...lists, Buffer.alloc(5)]);
  };

  const server = net.createServer((socket) => {
    // The client tears this down once its dial budget runs out; that must not
    // reach the process as an unhandled error.
    socket.on("error", () => {});
    socket.write(`${ident}\r\n`);
    socket.write(packet(kexinit()));
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, close: () => server.close() };
}

/**
 * A server offering `keyboard-interactive` and nothing else, so a dial reaches
 * the path where psilink itself answers the prompt with the operator's
 * password. Neither suite backend offers the method, and what is under test is
 * what the client renders of its own answer.
 */
function keyboardInteractivePeer(password: string): {
  port: Promise<number>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const hostKey = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "keyboard-interactive")
        ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
          if (answers[0] === password) ctx.accept();
          else ctx.reject();
        });
      else ctx.reject(["keyboard-interactive"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on("REALPATH", (id) => {
            sftp.name(id, [
              {
                filename: "/",
                longname: "/",
                attrs: {
                  mode: 0o40755,
                  uid: 0,
                  gid: 0,
                  size: 0,
                  atime: 0,
                  mtime: 0,
                },
              },
            ]);
          });
        });
      });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, close: () => server.close() };
}

/**
 * A listener that identifies itself and then refuses the connection with an
 * SSH_MSG_DISCONNECT of its own wording, the shape of a server turning a client
 * away. ssh2's `Server` sends no disconnect a test can word, and the client's
 * rendering of the one it receives is what is under test.
 */
function disconnectingPeer(description: string): {
  port: Promise<number>;
  close: () => void;
} {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (resolvePort = resolve));
  const disconnect = (): Buffer => {
    // SSH_MSG_DISCONNECT: the message number, the reason code, the description
    // and its language tag.
    const head = Buffer.alloc(5);
    head[0] = 1;
    head.writeUInt32BE(11, 1);
    return packet(Buffer.concat([head, nameList(description), nameList("")]));
  };
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end(
      Buffer.concat([
        Buffer.from("SSH-2.0-psilink-refusing-peer\r\n", "utf8"),
        disconnect(),
      ]),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    resolvePort((server.address() as net.AddressInfo).port);
  });
  return { port, close: () => server.close() };
}

/**
 * Dial `options` with an adapter built at `verbosity` -- the `-v` count -- under
 * a root log level of `rootLevel`, and hand back every diagnostic line the run
 * emitted. The root level is applied before the adapter is constructed because
 * a `getLoggerForVerbosity` logger is never more verbose than the root live when
 * it is built (`@psilink/core/testing`, `withCapturedLogs`).
 */
async function dialCapturingLogs(
  rootLevel: logLibrary.LogLevelNumbers,
  verbosity: number,
  options: Record<string, unknown>,
): Promise<{ lines: string[]; failure: unknown }> {
  const previousLevel = logLibrary.getLevel();
  setLogLevel(rootLevel);
  try {
    const [failure, logs] = await withCapturedLogs(
      async () => {
        const adapter = new SSH2SFTPClientAdapter({ verbosity });
        try {
          await adapter.connect(options);
          return undefined;
        } catch (err) {
          return err;
        } finally {
          await adapter.end().catch(() => {});
        }
      },
      () => true,
    );
    return { lines: logs.map((entry) => entry.message), failure };
  } finally {
    setLogLevel(previousLevel);
  }
}

// The rendered prefix names the logger that emitted the line, which is how a
// stack line is told from the adapter's own (core's `setLogPrefixer`).
const wireTraceOf = (lines: string[]): string[] =>
  lines.filter((line) => line.includes(`[${SSH_WIRE_TRACE_LOGGER_NAME}]`));

const holds = (lines: string[], pattern: RegExp): boolean =>
  lines.some((line) => pattern.test(line));

function serverDialOptions(): Record<string, unknown> {
  const server = sftpServer();
  // The pin belongs to a connection's `server` block rather than to ssh2's own
  // options, so it stays out of the dial.
  const { hostKeyFingerprint: _pin, ...auth } = serverAuth(server.usera);
  return {
    host: server.host,
    port: server.port,
    ...auth,
    readyTimeout: DIAL_BUDGET_MS,
    maxReconnectAttempts: 0,
  };
}

describe("a root log level of trace, with no -v count", () => {
  test(
    "answers from one run whether the handshake completed and on what",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { lines, failure } = await dialCapturingLogs(
        logLibrary.levels.TRACE,
        0,
        serverDialOptions(),
      );
      expect(failure).toBeUndefined();

      const trace = wireTraceOf(lines);
      expect(holds(trace, /Remote ident: 'SSH-2\.0-\S/)).toBe(true);
      expect(holds(trace, /Handshake: \(local\) KEX method: \S/)).toBe(true);
      expect(holds(trace, /Handshake: \(remote\) KEX method: \S/)).toBe(true);
      expect(holds(trace, /Handshake: KEX algorithm: \S/)).toBe(true);
      expect(holds(trace, /Handshake: Host key format: \S/)).toBe(true);
      expect(holds(trace, /Handshake: C->S [Cc]ipher: \S/)).toBe(true);
      expect(holds(trace, /Handshake: S->C [Cc]ipher: \S/)).toBe(true);
      expect(holds(trace, /Handshake completed/)).toBe(true);
      expect(holds(trace, /Received USERAUTH_SUCCESS/)).toBe(true);
    },
  );

  test(
    "reports no credential the dial put on the wire",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // A password of this file's own choosing, so a hit is the credential and
      // not a collision with a protocol name -- and one the server refuses, so
      // the value is one no backend holds. What matters is that the client
      // SENDS it, which the request line below is the evidence of; whether the
      // server then accepts is nothing the trace renders differently.
      const password = "psilink-wire-trace-probe-not-a-real-secret";
      const { privateKey: _key, ...rest } = serverDialOptions();
      const { lines } = await dialCapturingLogs(logLibrary.levels.TRACE, 0, {
        ...rest,
        password,
      });
      const trace = wireTraceOf(lines);
      expect(
        holds(trace, /Outbound: Sending USERAUTH_REQUEST \(password\)/),
      ).toBe(true);
      expect(lines.join("\n")).not.toContain(password);
    },
  );

  test(
    "reports no credential psilink itself answered a prompt with",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const password = "psilink-wire-trace-prompt-not-a-real-secret";
      const peer = keyboardInteractivePeer(password);
      try {
        const { lines, failure } = await dialCapturingLogs(
          logLibrary.levels.TRACE,
          0,
          {
            host: "127.0.0.1",
            port: await peer.port,
            username: "probe",
            password,
            tryKeyboard: true,
            readyTimeout: DIAL_BUDGET_MS,
            maxReconnectAttempts: 0,
          },
        );
        expect(failure).toBeUndefined();
        expect(
          holds(wireTraceOf(lines), /Outbound: Sending USERAUTH_INFO_RESPONSE/),
        ).toBe(true);
        expect(lines.join("\n")).not.toContain(password);
      } finally {
        peer.close();
      }
    },
  );
});

describe("every root log level below trace", () => {
  test.for([
    { name: "debug", rootLevel: logLibrary.levels.DEBUG, verbosity: 0 },
    { name: "info", rootLevel: logLibrary.levels.INFO, verbosity: 0 },
    { name: "warn", rootLevel: logLibrary.levels.WARN, verbosity: 0 },
    {
      name: "debug under the highest -v count",
      rootLevel: logLibrary.levels.DEBUG,
      verbosity: 2,
    },
  ])(
    "emits no wire trace at $name",
    { timeout: TEST_TIMEOUT_MS },
    async ({ rootLevel, verbosity }) => {
      const { lines, failure } = await dialCapturingLogs(
        rootLevel,
        verbosity,
        serverDialOptions(),
      );
      expect(failure).toBeUndefined();
      expect(wireTraceOf(lines)).toEqual([]);
    },
  );
});

describe("a peer's own bytes", () => {
  test(
    "reach the operator escaped rather than verbatim",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const peer = hostilePeer(
        "SSH-2.0-evil\x1b[31mRED\x07",
        "curve25519-sha256,evil\x1b[31mALG\x07back\\slash",
      );
      try {
        const { lines, failure } = await dialCapturingLogs(
          logLibrary.levels.TRACE,
          0,
          {
            host: "127.0.0.1",
            port: await peer.port,
            username: "probe",
            password: "probe",
            readyTimeout: DIAL_BUDGET_MS,
            maxReconnectAttempts: 0,
          },
        );
        expect(failure).toBeDefined();

        const trace = wireTraceOf(lines);
        // The name-list is what ssh2 hands over verbatim, so it is what the
        // escape has to catch; seeing the escaped form is what says the raw
        // bytes arrived and were caught here.
        expect(
          holds(trace, /Handshake: \(remote\) KEX method: .*evil\\x1b\[31mALG/),
        ).toBe(true);
        expect(holds(trace, /back\\\\slash/)).toBe(true);
        // The identification string is the half ssh2 escapes before handing it
        // over, so psilink's own escape lands on ssh2's backslash and the
        // operator reads it doubled. Held here so a version that stopped
        // escaping it is a changed rendering rather than a silent raw byte.
        expect(holds(trace, /Remote ident: .*evil\\\\x1B\[31mRED/)).toBe(true);
        for (const line of lines) {
          expect(line).not.toContain("\x1b");
          expect(line).not.toContain("\x07");
        }
      } finally {
        peer.close();
      }
    },
  );
});

/**
 * Run `probe` through the CLI's own logging bootstrap at the trace level with a
 * `--log-file`, close that sink where a command handler closes it, and hand back
 * the file's content and every byte the run put on stderr. The stderr capture
 * outlives the close by a beat, so a line the stack emits once the sink is gone
 * -- which reaches the console with a stack dump rather than the file -- is
 * caught here rather than only by the console sentinel.
 */
async function traceToLogFile(probe: () => Promise<unknown>): Promise<{
  logged: string[];
  stderr: string;
  failure: unknown;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-wire-trace-"));
  const logFile = path.join(dir, "trace.log");
  const previousLevel = logLibrary.getLevel();
  const stderr: string[] = [];
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  let failure: unknown;
  try {
    const logging = configureLogging({
      logLevel: logLibrary.levels.TRACE,
      logFile,
      name: "probe-host-key",
    });
    try {
      await probe();
    } catch (err) {
      failure = err;
    } finally {
      logging.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    setLogLevel(previousLevel);
    stderrWrite.mockRestore();
  }
  return {
    logged: fs.readFileSync(logFile, "utf8").split("\n"),
    stderr: stderr.join(""),
    failure,
  };
}

describe("a trace at the root level with a --log-file", () => {
  test(
    "puts a completed dial's last lines in the file and nothing on stderr",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const server = sftpServer();
      const { logged, stderr, failure } = await traceToLogFile(() =>
        probeHostKeyLines({
          sftpUrl: `sftp://${server.host}:${server.port}`,
          connectTimeoutSeconds: DIAL_BUDGET_MS / 1000,
          json: false,
          verbosity: 0,
        }),
      );
      expect(failure).toBeUndefined();

      const trace = wireTraceOf(logged);
      expect(holds(trace, /Outbound: Sending DISCONNECT/)).toBe(true);
      expect(holds(trace, /Socket ended/)).toBe(true);
      expect(holds(trace, /Socket closed/)).toBe(true);
      expect(holds(trace, /Global close event/)).toBe(true);
      expect(stderr).toBe("");
    },
  );

  test(
    "puts a refused dial's last lines there too, the peer's reason included",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const peer = disconnectingPeer("this test's own refusal");
      try {
        const port = await peer.port;
        const { logged, stderr, failure } = await traceToLogFile(() =>
          probeHostKeyLines({
            sftpUrl: `sftp://127.0.0.1:${port}`,
            connectTimeoutSeconds: DIAL_BUDGET_MS / 1000,
            json: false,
            verbosity: 0,
          }),
        );
        expect(failure).toBeDefined();

        const trace = wireTraceOf(logged);
        expect(
          holds(
            trace,
            /Inbound: Received DISCONNECT \(11, "this test's own refusal"\)/,
          ),
        ).toBe(true);
        expect(holds(trace, /Socket ended/)).toBe(true);
        expect(holds(trace, /Socket closed/)).toBe(true);
        expect(holds(trace, /Global close event/)).toBe(true);
        expect(stderr).toBe("");
      } finally {
        peer.close();
      }
    },
  );
});
