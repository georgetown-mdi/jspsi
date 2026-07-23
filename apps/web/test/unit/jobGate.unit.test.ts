import { describe, expect, test } from "vitest";

import { isJobApiEnabled, readJobApiConfig } from "@jobs/gate";

describe("readJobApiConfig", () => {
  test("reads the data root and trims it", () => {
    const config = readJobApiConfig({ JOB_DATA_ROOT: "  /srv/jobs  " });
    expect(config.dataRoot).toBe("/srv/jobs");
  });

  test("reads the console profile from VITE_DEPLOYMENT_PROFILE", () => {
    expect(
      readJobApiConfig({ VITE_DEPLOYMENT_PROFILE: "console" }).consoleProfile,
    ).toBe(true);
  });

  test("a hosted profile is not the console profile", () => {
    expect(
      readJobApiConfig({ VITE_DEPLOYMENT_PROFILE: "hosted" }).consoleProfile,
    ).toBe(false);
  });

  test("an unset profile defaults to hosted (not console)", () => {
    expect(readJobApiConfig({}).consoleProfile).toBe(false);
  });

  test("an unset data root disables the API", () => {
    expect(isJobApiEnabled(readJobApiConfig({}))).toBe(false);
  });

  test("no JOB_ALLOWED_HOSTS is an empty allowlist", () => {
    expect(readJobApiConfig({}).allowedHosts.size).toBe(0);
  });

  test("JOB_ALLOWED_HOSTS parses, trims, lowercases, and drops empties", () => {
    const config = readJobApiConfig({
      JOB_ALLOWED_HOSTS: " Proxy.Internal , ,console.lan,",
    });
    expect([...config.allowedHosts]).toEqual(["proxy.internal", "console.lan"]);
  });
});

describe("isJobApiEnabled requires a data root and the console profile", () => {
  test("a data root in a console build enables the API", () => {
    expect(
      isJobApiEnabled({
        dataRoot: "/x",
        consoleProfile: true,
        allowedHosts: new Set(),
      }),
    ).toBe(true);
  });

  test("a data root in a hosted build stays disabled", () => {
    expect(
      isJobApiEnabled({
        dataRoot: "/x",
        consoleProfile: false,
        allowedHosts: new Set(),
      }),
    ).toBe(false);
  });

  test("a data root with an unset profile stays disabled", () => {
    expect(isJobApiEnabled(readJobApiConfig({ JOB_DATA_ROOT: "/x" }))).toBe(
      false,
    );
  });

  test("no data root in a console build stays disabled", () => {
    expect(
      isJobApiEnabled({
        dataRoot: "",
        consoleProfile: true,
        allowedHosts: new Set(),
      }),
    ).toBe(false);
  });
});
