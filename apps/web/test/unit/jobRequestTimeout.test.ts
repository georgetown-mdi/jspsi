import http from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JOB_API_REQUEST_TIMEOUT_MS,
  MAX_CONFIG_HAND_BACK_BODY_BYTES,
  MAX_JOB_BODY_BYTES,
  MIN_JOB_UPLOAD_BYTES_PER_SECOND,
  jobApiRequestTimeoutMs,
} from "@jobs/routeSupport";

import {
  SIGNALING_REQUEST_TIMEOUT_MS,
  hardenUpgradeSurface,
} from "../../server/upgradeHardening";

import type { AddressInfo } from "node:net";

// The shared server's whole-request bound is sized for a signaling handshake,
// which has no body. A job-create or config upload has one of up to hundreds of
// MiB, so a server with the job API enabled takes a bound sized to that body.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the job API's whole-request bound", () => {
  test("gives the largest job body time to arrive at the minimum upload rate", () => {
    for (const bytes of [MAX_JOB_BODY_BYTES, MAX_CONFIG_HAND_BACK_BODY_BYTES])
      expect(
        (JOB_API_REQUEST_TIMEOUT_MS / 1000) * MIN_JOB_UPLOAD_BYTES_PER_SECOND,
      ).toBeGreaterThanOrEqual(bytes);
    expect(JOB_API_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      SIGNALING_REQUEST_TIMEOUT_MS,
    );
    // The value docs/spec/CHANNEL_SECURITY.md states.
    expect(JOB_API_REQUEST_TIMEOUT_MS).toBe(424_000);
  });

  test("applies only where the job API is enabled", () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("JOB_DATA_ROOT", "/data");
    expect(jobApiRequestTimeoutMs()).toBe(JOB_API_REQUEST_TIMEOUT_MS);
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect(jobApiRequestTimeoutMs()).toBeUndefined();
    vi.stubEnv("JOB_DATA_ROOT", "/data");
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "hosted");
    expect(jobApiRequestTimeoutMs()).toBeUndefined();
  });
});

/**
 * POST a body in steady chunks, never idle long enough for the idle reaper,
 * to a server hardened with `requestTimeoutMs`, and resolve with the status.
 * Node checks the whole-request bound on its connections sweep, run here every
 * 50 ms so the bound is felt at this scale.
 */
async function statusOfSteadyUpload(requestTimeoutMs: number): Promise<number> {
  const server = http.createServer(
    { connectionsCheckingInterval: 50 },
    (req, res) => {
      req.resume();
      req.on("end", () => res.end("received"));
    },
  );
  hardenUpgradeSurface(server, {
    headersTimeoutMs: 300,
    requestTimeoutMs,
    preHandshakeIdleMs: 1000,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/jobs",
        headers: { "content-type": "application/json" },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      let chunks = 0;
      const writer = setInterval(() => {
        if (request.destroyed) return clearInterval(writer);
        request.write("x".repeat(1024));
        chunks += 1;
        if (chunks === 12) {
          clearInterval(writer);
          request.end();
        }
      }, 100);
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe("a steady upload longer than the signaling-scale bound", () => {
  test("is cut with a 408 under that bound", async () => {
    expect(await statusOfSteadyUpload(400)).toBe(408);
  });

  test("arrives whole under a bound sized to the body", async () => {
    expect(await statusOfSteadyUpload(5000)).toBe(200);
  });
});
