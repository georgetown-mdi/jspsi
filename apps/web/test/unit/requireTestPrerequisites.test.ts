import { describe, expect, test, vi } from "vitest";

import {
  ALLOW_MISSING_PREREQUISITES_ENV,
  prerequisitesAreRequired,
  requireTestPrerequisites,
  webTestPrerequisites,
} from "../requireTestPrerequisites";
import { loopbackTlsCert } from "../utils/loopbackTlsCert";

import type { TestPrerequisite } from "../requireTestPrerequisites";

const present: TestPrerequisite = {
  name: "present tool",
  available: true,
  covers: "a leg that runs",
  remedy: "nothing to do",
};

const absent: TestPrerequisite = {
  name: "absent tool",
  available: false,
  covers: "the legs that need it",
  remedy: "install it",
};

describe("prerequisitesAreRequired", () => {
  test("a CI runner is provisioned to a spec, so it must supply them", () => {
    expect(prerequisitesAreRequired({ CI: "true" })).toBe(true);
    expect(prerequisitesAreRequired({ CI: "1" })).toBe(true);
  });

  test("a workstation is not held to one", () => {
    expect(prerequisitesAreRequired({})).toBe(false);
  });

  // A shell that exports CI empty, or a runner that sets it to false, is saying
  // it is not CI; reading any value as truthy would fail those runs.
  test("an empty or false CI is not CI", () => {
    expect(prerequisitesAreRequired({ CI: "" })).toBe(false);
    expect(prerequisitesAreRequired({ CI: "false" })).toBe(false);
  });

  test("the opt-out releases even a CI run", () => {
    expect(
      prerequisitesAreRequired({
        CI: "true",
        [ALLOW_MISSING_PREREQUISITES_ENV]: "1",
      }),
    ).toBe(false);
  });
});

describe("requireTestPrerequisites", () => {
  test("says nothing when the environment supplied everything", () => {
    const report = vi.fn();
    expect(() =>
      requireTestPrerequisites([present], { CI: "true" }, report),
    ).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  test("reports a missing prerequisite rather than letting the skip pass quietly", () => {
    const report = vi.fn();
    requireTestPrerequisites([present, absent], {}, report);
    expect(report).toHaveBeenCalledOnce();
    const message = report.mock.calls[0][0];
    expect(message).toContain("absent tool");
    expect(message).toContain("the legs that need it");
    expect(message).toContain("install it");
    expect(message).not.toContain("present tool");
  });

  test("fails the run where the environment was supposed to supply it", () => {
    const report = vi.fn();
    expect(() =>
      requireTestPrerequisites([absent], { CI: "true" }, report),
    ).toThrow(/absent tool/);
    expect(() =>
      requireTestPrerequisites([absent], { CI: "true" }, report),
    ).toThrow(ALLOW_MISSING_PREREQUISITES_ENV);
    expect(report).not.toHaveBeenCalled();
  });

  test("the opt-out turns a CI failure back into a reported skip", () => {
    const report = vi.fn();
    expect(() =>
      requireTestPrerequisites(
        [absent],
        { CI: "true", [ALLOW_MISSING_PREREQUISITES_ENV]: "1" },
        report,
      ),
    ).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
  });
});

describe("webTestPrerequisites", () => {
  // The suites skip on the certificate being null; the guard has to read that
  // same value, or a run could skip them with nothing declared missing.
  test("declares the loopback TLS certificate the signaling suites skip on", () => {
    const certificate = webTestPrerequisites().find(
      (prerequisite) => prerequisite.name === "loopback TLS certificate",
    );
    expect(certificate).toBeDefined();
    expect(certificate?.available).toBe(loopbackTlsCert !== null);
    expect(certificate?.remedy).toContain("openssl");
  });
});
