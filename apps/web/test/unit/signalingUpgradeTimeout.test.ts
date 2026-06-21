import http from "node:http";
import net from "node:net";

import { describe, expect, test, vi } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
  hardenUpgradeSurface,
} from "../../server/upgradeHardening";

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
});
