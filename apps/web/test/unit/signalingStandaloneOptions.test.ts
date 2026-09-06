import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import {
  BIND_HOST_ENV,
  BIND_PORT_ENV,
  READINESS_BODY,
  StandaloneOptionError,
  createStandaloneRequestHandler,
  resolveStandaloneOptions,
} from "@psilink/peerjs-broker/standaloneOptions";

import type { AddressInfo } from "node:net";

// The standalone broker runner's operator surface: what it binds and what its
// readiness probe answers. Both halves live in `standaloneOptions.ts` rather
// than in the runner beside it, which listens at import time, so they can be
// driven here without spawning a broker. The runner's own wiring of them is
// exercised end to end by the CLI's signaling suite, which spawns the real
// process (apps/cli/test/integration/webrtc/broker.test.ts).
//
// This workspace hosts the check because it is where the broker's other unit
// coverage sits: the package ships no test project of its own.

describe("resolveStandaloneOptions", () => {
  test("defaults to loopback on an ephemeral port under the /api mount", () => {
    expect(resolveStandaloneOptions([], {})).toEqual({
      host: "127.0.0.1",
      port: 0,
      path: "/api",
      key: "peerjs",
      readinessPath: "/api/health",
    });
  });

  test("takes each setting from its flag, deriving the probe from the mount", () => {
    expect(
      resolveStandaloneOptions(
        [
          "--host",
          "0.0.0.0",
          "--port",
          "9000",
          "--path",
          "/signal",
          "--key",
          "a-realm-key",
        ],
        {},
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 9000,
      path: "/signal",
      key: "a-realm-key",
      readinessPath: "/signal/health",
    });
  });

  test("takes the address and port from the environment", () => {
    const options = resolveStandaloneOptions([], {
      [BIND_HOST_ENV]: "::1",
      [BIND_PORT_ENV]: " 9000 ",
    });
    expect(options.host).toBe("::1");
    expect(options.port).toBe(9000);
  });

  test("prefers a flag to the environment variable beside it", () => {
    const options = resolveStandaloneOptions(
      ["--host", "0.0.0.0", "--port", "9001"],
      { [BIND_HOST_ENV]: "::1", [BIND_PORT_ENV]: "9000" },
    );
    expect(options.host).toBe("0.0.0.0");
    expect(options.port).toBe(9001);
  });

  test("treats an environment variable set to an empty value as unset", () => {
    const options = resolveStandaloneOptions([], {
      [BIND_HOST_ENV]: "",
      [BIND_PORT_ENV]: "   ",
    });
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(0);
  });

  test.each([
    ["-1", "a negative number"],
    ["70000", "a number above the port range"],
    ["9000abc", "trailing text"],
    ["0x2328", "a hexadecimal literal"],
    ["9e3", "an exponent"],
    ["", "an empty value"],
  ])("refuses --port %s (%s)", (value) => {
    expect(() => resolveStandaloneOptions(["--port", value], {})).toThrow(
      StandaloneOptionError,
    );
  });

  test("names the environment variable a bad port came from", () => {
    expect(() =>
      resolveStandaloneOptions([], { [BIND_PORT_ENV]: "not-a-port" }),
    ).toThrow(new RegExp(BIND_PORT_ENV));
  });

  test("names the flag a bad port came from", () => {
    expect(() => resolveStandaloneOptions(["--port", "-1"], {})).toThrow(
      /--port/,
    );
  });

  test("accepts port 0 and the highest port explicitly", () => {
    expect(resolveStandaloneOptions(["--port", "0"], {}).port).toBe(0);
    expect(resolveStandaloneOptions(["--port", "65535"], {}).port).toBe(65_535);
  });

  test("refuses a repeated flag rather than letting the second value win", () => {
    expect(() =>
      resolveStandaloneOptions(["--port", "9000", "--port", "9001"], {}),
    ).toThrow(/--port may be given only once/);
  });

  test("refuses a flag with no value, including one followed by a flag", () => {
    expect(() => resolveStandaloneOptions(["--port"], {})).toThrow(
      /--port requires a value/,
    );
    expect(() =>
      resolveStandaloneOptions(["--port", "--host", "0.0.0.0"], {}),
    ).toThrow(/--port requires a value/);
  });

  test("refuses an unrecognized argument rather than binding the defaults", () => {
    expect(() => resolveStandaloneOptions(["--prot", "9000"], {})).toThrow(
      /Unknown argument: --prot/,
    );
    expect(() => resolveStandaloneOptions(["9000"], {})).toThrow(
      /Unknown argument: 9000/,
    );
  });

  test("refuses a blank address", () => {
    expect(() => resolveStandaloneOptions(["--host", "  "], {})).toThrow(
      /--host must not be empty/,
    );
  });

  test("refuses a mount no request path could match", () => {
    expect(() => resolveStandaloneOptions(["--path", "api"], {})).toThrow(
      /--path must begin with/,
    );
  });

  test("keeps the probe beside the mount when the mount is the root", () => {
    expect(resolveStandaloneOptions(["--path", "/"], {}).readinessPath).toBe(
      "/health",
    );
  });
});

describe("the standalone readiness probe", () => {
  const servers: Array<http.Server> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  /** A loopback server running the runner's own request handler, and its base
   * URL. Nothing here mounts the signaling server: the probe is the whole of
   * what this handler answers. */
  async function servedAt(readinessPath: string): Promise<string> {
    const server = http.createServer(
      createStandaloneRequestHandler(readinessPath),
    );
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("answers a GET on the mount's health path", async () => {
    const base = await servedAt("/api/health");
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(READINESS_BODY);
  });

  test("answers a GET carrying a query string a probe appended", async () => {
    const base = await servedAt("/api/health");
    const response = await fetch(`${base}/api/health?attempt=2`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(READINESS_BODY);
  });

  test("answers a HEAD with the status and no body", async () => {
    const base = await servedAt("/api/health");
    const response = await fetch(`${base}/api/health`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("moves with the mount rather than sitting at a fixed path", async () => {
    const base = await servedAt("/signal/health");
    expect((await fetch(`${base}/signal/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(404);
  });

  test.each([
    ["/api/healthz", "a path the probe path is a prefix of"],
    ["/health", "the same segment outside the mount"],
    ["/", "the root"],
    ["/api/%68ealth", "a percent-encoded spelling"],
  ])("refuses %s (%s)", async (requestPath) => {
    const base = await servedAt("/api/health");
    expect((await fetch(`${base}${requestPath}`)).status).toBe(404);
  });

  test("refuses a method other than GET or HEAD on the probe path", async () => {
    const base = await servedAt("/api/health");
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect((await fetch(`${base}/api/health`, { method })).status).toBe(404);
    }
  });
});
