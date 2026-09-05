import net from "node:net";

import logLibrary from "loglevel";
import ssh2 from "ssh2";
import { describe, expect, test } from "vitest";
import { setLogLevel } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { SSH_WIRE_TRACE_PREFIX } from "../../src/connection/sftpWireTrace";
import { serverAuth, sftpServer } from "../sftpServer/testContext";

// What a dial reports about its own SSH handshake, driven against the real
// stack rather than modeled from ssh2's callback contract (CLAUDE.md,
// settle-by-driving-the-tool). Four things are held here: that the highest
// diagnostic level answers "did the handshake complete, and on what" from one
// run; that no credential the dial sends is among what it reports; that every
// level below it emits not one line of it; and that a peer's own bytes reach
// the operator escaped, since a name-list the peer chose arrives verbatim from
// ssh2 (docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack").

const TEST_TIMEOUT_MS = 60_000;
const DIAL_BUDGET_MS = 5_000;

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

  const nameList = (value: string): Buffer => {
    const body = Buffer.from(value, "utf8");
    const framed = Buffer.alloc(4 + body.length);
    framed.writeUInt32BE(body.length, 0);
    body.copy(framed, 4);
    return framed;
  };
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
  const packet = (payload: Buffer): Buffer => {
    let padding = 8 - ((payload.length + 5) % 8);
    if (padding < 4) padding += 8;
    const framed = Buffer.alloc(4 + 1 + payload.length + padding);
    framed.writeUInt32BE(1 + payload.length + padding, 0);
    framed[4] = padding;
    payload.copy(framed, 5);
    return framed;
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
 * Dial `options` with an adapter built at `verbosity` under a root log level of
 * `rootLevel`, and hand back every diagnostic line the run emitted. The root
 * level is raised before the adapter is constructed because a
 * `getLoggerForVerbosity` logger is never more verbose than the root live when
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
          // The stack emits its last transport lines after end() resolves, and
          // a line landing outside this capture reaches the console, where the
          // sentinel reads console.trace's stack as unescaped output. Lower the
          // levels here, with no await between, so nothing more can be emitted.
          setLogLevel(previousLevel);
        }
      },
      () => true,
    );
    return { lines: logs.map((entry) => entry.message), failure };
  } finally {
    setLogLevel(previousLevel);
  }
}

const wireTraceOf = (lines: string[]): string[] =>
  lines.filter((line) => line.includes(SSH_WIRE_TRACE_PREFIX));

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

describe("the highest diagnostic level", () => {
  test(
    "answers from one run whether the handshake completed and on what",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { lines, failure } = await dialCapturingLogs(
        logLibrary.levels.TRACE,
        2,
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
      const { lines } = await dialCapturingLogs(logLibrary.levels.TRACE, 2, {
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
          2,
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

describe("every level below it", () => {
  test.for([
    { name: "debug", rootLevel: logLibrary.levels.DEBUG, verbosity: 2 },
    { name: "info", rootLevel: logLibrary.levels.INFO, verbosity: 2 },
    { name: "warn", rootLevel: logLibrary.levels.WARN, verbosity: 2 },
    {
      name: "trace with a lower adapter verbosity",
      rootLevel: logLibrary.levels.TRACE,
      verbosity: 1,
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
          2,
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
