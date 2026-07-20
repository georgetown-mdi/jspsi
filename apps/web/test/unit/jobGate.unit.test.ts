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
});

describe("isJobApiEnabled requires a data root and the console profile", () => {
  test("a data root in a console build enables the API", () => {
    expect(isJobApiEnabled({ dataRoot: "/x", consoleProfile: true })).toBe(
      true,
    );
  });

  test("a data root in a hosted build stays disabled", () => {
    expect(isJobApiEnabled({ dataRoot: "/x", consoleProfile: false })).toBe(
      false,
    );
  });

  test("a data root with an unset profile stays disabled", () => {
    expect(isJobApiEnabled(readJobApiConfig({ JOB_DATA_ROOT: "/x" }))).toBe(
      false,
    );
  });

  test("no data root in a console build stays disabled", () => {
    expect(isJobApiEnabled({ dataRoot: "", consoleProfile: true })).toBe(false);
  });
});
