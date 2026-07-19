import { describe, expect, test } from "vitest";

import {
  JobApiConfigError,
  assertJobApiStartupSafe,
  isJobApiEnabled,
  isLoopbackHost,
  readJobApiConfig,
} from "@jobs/gate";

import type { JobApiConfig } from "@jobs/gate";

const enabled: JobApiConfig = { dataRoot: "/srv/jobs" };
const disabled: JobApiConfig = { dataRoot: "" };

describe("readJobApiConfig", () => {
  test("reads the data root and trims it", () => {
    const config = readJobApiConfig({ JOB_DATA_ROOT: "  /srv/jobs  " });
    expect(config.dataRoot).toBe("/srv/jobs");
  });

  test("an unset data root disables the API", () => {
    expect(isJobApiEnabled(readJobApiConfig({}))).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  test("recognizes loopback forms and rejects public/all-interface binds", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  test("a hostname is not loopback even with a 127. prefix", () => {
    // A 127.<label>.<tld> name can resolve to a public address; only a real
    // IPv4 literal in 127.0.0.0/8 is loopback.
    expect(isLoopbackHost("127.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("evil.com")).toBe(false);
  });
});

describe("assertJobApiStartupSafe fails closed", () => {
  test("refuses a non-loopback bind whenever the API is enabled", () => {
    // Loopback is the only supported bind: there is no token or other override
    // that admits a non-loopback bind.
    expect(() => assertJobApiStartupSafe(enabled, "0.0.0.0")).toThrow(
      JobApiConfigError,
    );
    expect(() => assertJobApiStartupSafe(enabled, "10.0.0.5")).toThrow(
      JobApiConfigError,
    );
    expect(() => assertJobApiStartupSafe(enabled, undefined)).toThrow(
      JobApiConfigError,
    );
  });

  test("allows a loopback bind", () => {
    expect(() => assertJobApiStartupSafe(enabled, "127.0.0.1")).not.toThrow();
    expect(() => assertJobApiStartupSafe(enabled, "localhost")).not.toThrow();
  });

  test("allows a disabled API on any bind", () => {
    expect(() => assertJobApiStartupSafe(disabled, "0.0.0.0")).not.toThrow();
  });
});
