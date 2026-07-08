import { afterAll, beforeAll, expect, test } from "vitest";
import ssh2 from "ssh2";
import type { Connection } from "ssh2";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

const { Server, utils } = ssh2;

const USERNAME = "kbduser";
const PASSWORD = "kbd-secret";

// A minimal SFTP server that accepts ONLY keyboard-interactive authentication:
// it refuses the direct `password` method and advertises keyboard-interactive as
// the sole continuation, then prompts for and verifies the password. This is the
// hardened-server configuration a `password`-only client (and plain `ssh`) is
// refused by, while a GUI SFTP client -- and now the CLI with
// keyboard_interactive enabled -- authenticates. The session accepts the SFTP
// subsystem so a client `connect` completes; no file handlers are needed (these
// tests assert on the handshake outcome, and connect resolving is itself proof
// of a completed authentication).
async function startKeyboardInteractiveServer(): Promise<{
  host: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const hostKey = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    // A peer reset at teardown surfaces as 'error'; without a listener it would
    // crash the test process, and there is nothing to recover here.
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));

    client.on("authentication", (ctx) => {
      if (ctx.username !== USERNAME) return ctx.reject();
      if (ctx.method === "keyboard-interactive") {
        // Issue TWO prompts, both expecting the password, and accept only when
        // both answers match. This exercises the client's multi-answer path
        // (RFC 4256: one response per prompt) through a real handshake: a client
        // that answered only the first prompt would send one response for two
        // prompts and be rejected, so it catches a regression to finish([password]).
        ctx.prompt(
          [
            { prompt: "Password: ", echo: false },
            { prompt: "Repeat password: ", echo: false },
          ],
          (answers: string[]) => {
            if (
              answers.length === 2 &&
              answers[0] === PASSWORD &&
              answers[1] === PASSWORD
            )
              return ctx.accept();
            return ctx.reject();
          },
        );
        return;
      }
      // Refuse every other method (`none` and `password` included) but advertise
      // keyboard-interactive as the only continuation, so a client offering only
      // `password` exhausts its methods while one that tries keyboard-interactive
      // is routed to it.
      return ctx.reject(["keyboard-interactive"]);
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          // Establish the SFTP subsystem so the client's connect resolves; no
          // request handlers are needed for the connect-and-end assertions.
          acceptSftp();
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onErr = (err: Error): void => reject(err);
    server.once("error", onErr);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onErr);
      // Past startup, swallow server-level errors so a late socket fault cannot
      // crash the test process.
      server.on("error", () => {});
      const address = server.address();
      if (typeof address !== "object" || !address)
        return reject(new Error("server reported no listen address"));
      resolve(address.port);
    });
  });

  return {
    host: "127.0.0.1",
    port,
    async stop() {
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
    },
  };
}

let srv: Awaited<ReturnType<typeof startKeyboardInteractiveServer>>;

beforeAll(async () => {
  srv = await startKeyboardInteractiveServer();
});

afterAll(async () => {
  await srv?.stop();
});

test("tryKeyboard authenticates against a server that refuses the password method", async () => {
  const adapter = new SSH2SFTPClientAdapter();
  try {
    // connect resolving is proof of a completed handshake: ssh2-sftp-client only
    // resolves after authentication succeeds AND the SFTP subsystem is
    // established. The keyboard-interactive handler answered the server's prompt
    // with the configured password.
    await adapter.connect({
      host: srv.host,
      port: srv.port,
      username: USERNAME,
      password: PASSWORD,
      tryKeyboard: true,
      maxReconnectAttempts: 0,
    });
  } finally {
    await adapter.end();
  }
});

test("without tryKeyboard the same server refuses the password-only client", async () => {
  // The negative control: the server offers only keyboard-interactive, so a
  // client presenting just the `password` method exhausts its methods and the
  // connect fails. This proves the server genuinely refuses `password` and that
  // tryKeyboard is what makes the positive case above succeed (rather than the
  // server accepting the direct password all along). maxReconnectAttempts: 0 so
  // the auth failure surfaces promptly instead of being retried.
  const adapter = new SSH2SFTPClientAdapter();
  await expect(
    adapter.connect({
      host: srv.host,
      port: srv.port,
      username: USERNAME,
      password: PASSWORD,
      maxReconnectAttempts: 0,
    }),
  ).rejects.toThrow();
});
