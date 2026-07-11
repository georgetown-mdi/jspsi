import { describe, expect, test } from "vitest";

import {
  JobApiConfigError,
  assertJobApiStartupSafe,
  constantTimeEquals,
  gateRequest,
  isJobApiEnabled,
  isLoopbackHost,
  readJobApiConfig,
} from "@jobs/gate";

import type { JobApiConfig } from "@jobs/gate";

const enabledNoToken: JobApiConfig = { dataRoot: "/srv/jobs", token: "" };
const enabledWithToken: JobApiConfig = {
  dataRoot: "/srv/jobs",
  token: "s3cret-token",
};
const disabled: JobApiConfig = { dataRoot: "", token: "" };

describe("readJobApiConfig", () => {
  test("reads the env vars and trims the data root", () => {
    const config = readJobApiConfig({
      JOB_DATA_ROOT: "  /srv/jobs  ",
      JOB_API_TOKEN: "tok",
    });
    expect(config.dataRoot).toBe("/srv/jobs");
    expect(config.token).toBe("tok");
  });

  test("an unset data root disables the API", () => {
    expect(isJobApiEnabled(readJobApiConfig({}))).toBe(false);
  });

  test("a whitespace-only token is treated as unset, not real auth", () => {
    const config = readJobApiConfig({
      JOB_DATA_ROOT: "/srv/jobs",
      JOB_API_TOKEN: "   ",
    });
    expect(config.token).toBe("");
    // A blank token must not satisfy the startup gate on a non-loopback bind.
    expect(() => assertJobApiStartupSafe(config, "0.0.0.0")).toThrow(
      JobApiConfigError,
    );
  });
});

describe("gateRequest", () => {
  test("a disabled API reports disabled without consulting the token", () => {
    expect(gateRequest(disabled, "Bearer anything")).toBe("disabled");
  });

  test("an enabled unauthenticated API allows any request", () => {
    expect(gateRequest(enabledNoToken, null)).toBe("allowed");
  });

  test("a token-protected API requires a matching bearer", () => {
    expect(gateRequest(enabledWithToken, null)).toBe("unauthorized");
    expect(gateRequest(enabledWithToken, "Bearer wrong")).toBe("unauthorized");
    expect(gateRequest(enabledWithToken, "Basic s3cret-token")).toBe(
      "unauthorized",
    );
    expect(gateRequest(enabledWithToken, "Bearer s3cret-token")).toBe(
      "allowed",
    );
  });
});

describe("constantTimeEquals", () => {
  test("matches identical strings and rejects differing ones of any length", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("abc", "abx")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
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
  test("refuses a non-loopback bind with the API enabled and no token", () => {
    expect(() => assertJobApiStartupSafe(enabledNoToken, "0.0.0.0")).toThrow(
      JobApiConfigError,
    );
    expect(() => assertJobApiStartupSafe(enabledNoToken, undefined)).toThrow(
      JobApiConfigError,
    );
  });

  test("allows a loopback bind without a token", () => {
    expect(() =>
      assertJobApiStartupSafe(enabledNoToken, "127.0.0.1"),
    ).not.toThrow();
  });

  test("allows a non-loopback bind when a token is set", () => {
    expect(() =>
      assertJobApiStartupSafe(enabledWithToken, "0.0.0.0"),
    ).not.toThrow();
  });

  test("allows a disabled API on any bind", () => {
    expect(() => assertJobApiStartupSafe(disabled, "0.0.0.0")).not.toThrow();
  });
});
