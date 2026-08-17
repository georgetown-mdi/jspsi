import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
  hardenUpgradeSurface,
} from "../../server/upgradeHardening";
import { createLoopbackTlsCert } from "../utils/loopbackTlsCert";

import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

// gap 1: a slow or partial upgrade handshake is bounded and closed server-side
// rather than held open. The end-to-end behavior was verified against plain Node
// on the supported runtime (Node >= 26): the timeout fires `clientError` with
// `ERR_HTTP_REQUEST_TIMEOUT` and the handler responds 408 and closes -- the close
// landing on Node's periodic connections sweep, so headersTimeout plus up to one
// sweep interval, not instantly. It is not reproduced here as a live-socket
// timing test: under vitest, loading `ws` anywhere in the worker disrupts Node's
// request-timeout path on an unrelated server, which would make such a test
// flaky. Instead this pins the two code paths the entry owns -- the bounds are
// set, and the wired `clientError` handler closes a stalled or malformed
// handshake.

function fakeSocket(writable: boolean): {
  socket: Duplex;
  ended: Array<string>;
  destroyed: () => boolean;
} {
  let wasDestroyed = false;
  const ended: Array<string> = [];
  const socket = {
    writable,
    // `end(chunk, cb)` flushes then fires the callback, where the handler reaps
    // the socket; invoke it so the destroy half is exercised.
    end: (chunk?: string, cb?: () => void) => {
      if (typeof chunk === "string") ended.push(chunk);
      if (typeof cb === "function") cb();
    },
    destroy: () => {
      wasDestroyed = true;
    },
  } as unknown as Duplex;
  return { socket, ended, destroyed: () => wasDestroyed };
}

function emitClientError(
  server: http.Server,
  code: string,
  socket: Duplex,
): void {
  const err: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
  server.emit("clientError", err, socket);
}

describe("hardenUpgradeSurface", () => {
  test("applies the documented default header and request timeouts", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    expect(server.headersTimeout).toBe(SIGNALING_HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(SIGNALING_REQUEST_TIMEOUT_MS);
    expect(server.listenerCount("clientError")).toBe(1);
    server.close();
  });

  test("honors explicit timeout overrides", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server, {
      headersTimeoutMs: 300,
      requestTimeoutMs: 600,
    });
    expect(server.headersTimeout).toBe(300);
    expect(server.requestTimeout).toBe(600);
    server.close();
  });

  test("closes a stalled handshake with a 408, then destroys it", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    const { socket, ended, destroyed } = fakeSocket(true);
    emitClientError(server, "ERR_HTTP_REQUEST_TIMEOUT", socket);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain("408 Request Timeout");
    expect(ended[0]).toContain("Connection: close");
    // end() only half-closes; the socket must also be destroyed so a peer that
    // ignores the FIN cannot hold it half-open.
    expect(destroyed()).toBe(true);
    server.close();
  });

  test("closes a malformed handshake with a 400, then destroys it", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    const { socket, ended, destroyed } = fakeSocket(true);
    emitClientError(server, "HPE_INVALID_METHOD", socket);
    expect(ended[0]).toContain("400 Bad Request");
    expect(destroyed()).toBe(true);
    server.close();
  });

  test("is idempotent -- re-hardening does not stack clientError handlers", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    hardenUpgradeSurface(server);
    expect(server.listenerCount("clientError")).toBe(1);
    // A single error closes the socket once, not once per stacked handler.
    const { socket, ended } = fakeSocket(true);
    emitClientError(server, "ERR_HTTP_REQUEST_TIMEOUT", socket);
    expect(ended).toHaveLength(1);
    server.close();
  });

  test("destroys an unwritable handshake socket", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    const { socket, ended, destroyed } = fakeSocket(false);
    const destroySpy = vi.spyOn(socket, "destroy");
    emitClientError(server, "ERR_HTTP_REQUEST_TIMEOUT", socket);
    expect(ended).toHaveLength(0);
    expect(destroyed()).toBe(true);
    expect(destroySpy).toHaveBeenCalled();
    server.close();
  });

  // A live (but fast) socket test for the one hold the header/request timeouts
  // cannot bound: a peer that completes the TCP handshake and then sends nothing.
  // This uses a real `net` socket on a short clock -- no `ws` -- so it does not
  // hit the worker-isolation flakiness that keeps the header-timeout path out of
  // a live test here.
  test("reaps a connected socket that never starts a request", async () => {
    const server = http.createServer();
    hardenUpgradeSurface(server, { preHandshakeIdleMs: 400 });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const closedMs = await new Promise<number | null>((resolve) => {
        const start = Date.now();
        // Connect and send nothing -- there is no request, so headersTimeout and
        // requestTimeout never engage; only the idle reaper can close this.
        const socket = net.connect(port, "127.0.0.1");
        socket.on("close", () => resolve(Date.now() - start));
        socket.on("error", () => {});
        setTimeout(() => resolve(null), 2_000);
      });
      expect(closedMs).not.toBeNull();
      expect(closedMs).toBeLessThan(1_500);
    } finally {
      server.close();
    }
  });

  test("registers an idempotent pre-handshake idle reaper", () => {
    const server = http.createServer();
    // http.Server starts with its own internal connection listener; harden must
    // add exactly one more, and a repeat call must not stack a second.
    const before = server.listenerCount("connection");
    hardenUpgradeSurface(server);
    hardenUpgradeSurface(server);
    expect(server.listenerCount("connection")).toBe(before + 1);
    server.close();
  });

  test("registers an idempotent idle-bound release hook", () => {
    const server = http.createServer();
    const before = server.listenerCount("request");
    hardenUpgradeSurface(server);
    hardenUpgradeSurface(server);
    expect(server.listenerCount("request")).toBe(before + 1);
    server.close();
  });

  test("adds no upgrade listener, leaving the signaling server the sole one", () => {
    // The signaling server decides whether an unhandled upgrade is its to close
    // by testing that it is the only `upgrade` listener; a listener added here
    // would silently flip that test on the production server.
    const server = http.createServer();
    hardenUpgradeSurface(server);
    expect(server.listenerCount("upgrade")).toBe(0);
    server.close();
  });

  test("does not cut a connection awaiting a slow response", async () => {
    // The response is withheld far longer than the idle bound, with no byte
    // moving in either direction meanwhile: the socket is idle by any read/write
    // measure, but it owes the server nothing, so the bound must not reach it.
    const idleMs = 300;
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end("late"), idleMs * 4);
    });
    hardenUpgradeSurface(server, { preHandshakeIdleMs: idleMs });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/", agent: false },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve(text));
          },
        );
        req.on("error", reject);
      });
      expect(body).toBe("late");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("does not cut a streaming response quiet for longer than the bound", async () => {
    // The shape the console's job event stream takes: a long-lived response that
    // is legitimately silent between frames while an exchange runs. Both frames
    // must arrive on the one connection, with the quiet window between them
    // several times the bound.
    const idleMs = 300;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, idleMs * 4);
    });
    hardenUpgradeSurface(server, { preHandshakeIdleMs: idleMs });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const frames = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port, path: "/events", agent: false },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve(text));
            res.on("aborted", () =>
              reject(new Error("stream cut before it ended")),
            );
          },
        );
        req.on("error", reject);
      });
      expect(frames).toContain("data: first");
      expect(frames).toContain("data: second");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("still reaps a socket that stalls part-way through its request", async () => {
    // A dawdler that has sent bytes but no complete request owes the server one,
    // so the bound still reaches it -- the release is keyed on a request arriving,
    // not on any byte arriving.
    const idleMs = 400;
    const server = http.createServer((_req, res) => res.end("ok"));
    hardenUpgradeSurface(server, { preHandshakeIdleMs: idleMs });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const closedMs = await new Promise<number | null>((resolve) => {
        const start = Date.now();
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write("GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        });
        socket.on("close", () => resolve(Date.now() - start));
        socket.on("error", () => {});
        setTimeout(() => resolve(null), 3_000);
      });
      expect(closedMs).not.toBeNull();
      expect(closedMs).toBeLessThan(2_500);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

// Over TLS the socket the HTTP layer hands out -- to the request hook, and to
// `ws` on the 101 -- is the TLSSocket wrapping the accepted socket, a different
// object from the one the `connection` event delivered. A bound left on the
// wrapped socket therefore survives every release and reaps a live connection,
// which only an HTTPS server exercises: the plain-HTTP cases above hand out the
// same object throughout. `apps/web/server/custom-entry.ts` builds an HttpsServer
// whenever NITRO_SSL_CERT and NITRO_SSL_KEY are set.
describe.skipIf(process.platform === "win32")(
  "hardenUpgradeSurface over TLS",
  () => {
    const idleMs = 300;
    let credentials: ReturnType<typeof createLoopbackTlsCert>;

    beforeAll(() => {
      credentials = createLoopbackTlsCert();
    });

    async function startHardenedTlsServer(
      handler?: http.RequestListener,
    ): Promise<{ server: https.Server; port: number }> {
      const server = https.createServer(credentials, handler);
      hardenUpgradeSurface(server, { preHandshakeIdleMs: idleMs });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      return { server, port: (server.address() as AddressInfo).port };
    }

    function timeToClose(
      socket: net.Socket,
      budgetMs: number,
    ): Promise<number | null> {
      return new Promise((resolve) => {
        const start = Date.now();
        socket.on("close", () => resolve(Date.now() - start));
        socket.on("error", () => {});
        setTimeout(() => resolve(null), budgetMs);
      });
    }

    test("does not cut a TLS connection awaiting a slow response", async () => {
      const { server, port } = await startHardenedTlsServer((_req, res) => {
        setTimeout(() => res.end("late"), idleMs * 4);
      });
      try {
        const body = await new Promise<string>((resolve, reject) => {
          const req = https.get(
            {
              host: "127.0.0.1",
              port,
              path: "/",
              agent: false,
              rejectUnauthorized: false,
            },
            (res) => {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (text += chunk));
              res.on("end", () => resolve(text));
            },
          );
          req.on("error", reject);
        });
        expect(body).toBe("late");
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    test("reaps a TLS connection that hands over no request", async () => {
      const { server, port } = await startHardenedTlsServer((_req, res) =>
        res.end("ok"),
      );
      try {
        const closedMs = await timeToClose(
          tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }),
          2_000,
        );
        expect(closedMs).not.toBeNull();
        expect(closedMs).toBeLessThan(1_500);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    test("reaps a connection that never starts its TLS handshake", async () => {
      // The window the wrapped socket alone can cover: no TLSSocket exists yet.
      const { server, port } = await startHardenedTlsServer((_req, res) =>
        res.end("ok"),
      );
      try {
        const closedMs = await timeToClose(
          net.connect(port, "127.0.0.1"),
          2_000,
        );
        expect(closedMs).not.toBeNull();
        expect(closedMs).toBeLessThan(1_500);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  },
);
