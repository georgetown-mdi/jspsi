import http from "node:http";

import { describe, expect, test, vi } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
  hardenUpgradeSurface,
} from "../../server/upgradeHardening";

import type { Duplex } from "node:stream";

// gap 1: a slow or partial upgrade handshake is bounded and closed server-side
// rather than held open. The end-to-end behavior -- Node firing `clientError`
// once the short headersTimeout elapses, and the handler closing the socket --
// was verified against plain Node (the connection is closed at ~headersTimeout
// with a 408). It is not reproduced here as a live-socket timing test: under
// vitest, loading `ws` anywhere in the worker disrupts Node's request-timeout
// path on an unrelated server, which would make such a test flaky. Instead this
// pins the two code paths the entry owns -- the bounds are set, and the wired
// `clientError` handler closes a stalled or malformed handshake.

function fakeSocket(writable: boolean): {
  socket: Duplex;
  ended: Array<string>;
  destroyed: () => boolean;
} {
  let wasDestroyed = false;
  const ended: Array<string> = [];
  const socket = {
    writable,
    end: (chunk?: string) => {
      if (typeof chunk === "string") ended.push(chunk);
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

  test("closes a stalled handshake with a 408 and Connection: close", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    const { socket, ended } = fakeSocket(true);
    emitClientError(server, "ERR_HTTP_REQUEST_TIMEOUT", socket);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain("408 Request Timeout");
    expect(ended[0]).toContain("Connection: close");
    server.close();
  });

  test("closes a malformed handshake with a 400", () => {
    const server = http.createServer();
    hardenUpgradeSurface(server);
    const { socket, ended } = fakeSocket(true);
    emitClientError(server, "HPE_INVALID_METHOD", socket);
    expect(ended[0]).toContain("400 Bad Request");
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
});
