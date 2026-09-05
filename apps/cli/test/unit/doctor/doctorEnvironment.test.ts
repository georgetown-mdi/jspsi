import { describe, expect, test } from "vitest";
import { UsageError } from "@psilink/core";

import {
  readSmbMountInput,
  readSmbProbeInput,
} from "../../../src/doctor/smbEnvironment";

const COMPLETE = {
  SMB_SERVER: "files.example.org",
  SMB_SHARE: "exchange",
  SMB_PATH: "dropbox/q3",
  SMB_USER: "svc-psilink",
  SMB_DOMAIN: "AGENCY",
  SMB_PASS: "correct horse",
  SMB_DIALECT: "SMB3",
  SMB_MARKER: "psilink-check.txt",
  SMB_TOKEN: "abc123",
};

describe("the environment contract", () => {
  test("reads every variable the setup script passes", () => {
    expect(readSmbProbeInput(COMPLETE)).toEqual({
      server: "files.example.org",
      share: "exchange",
      subdirectory: "dropbox/q3",
      username: "svc-psilink",
      domain: "AGENCY",
      password: "correct horse",
      dialect: "SMB3",
      marker: "psilink-check.txt",
      token: "abc123",
    });
  });

  test("the optional variables default to empty rather than being required", () => {
    const input = readSmbProbeInput({
      SMB_SERVER: "files",
      SMB_SHARE: "exchange",
      SMB_USER: "svc",
    });
    expect(input.subdirectory).toBe("");
    expect(input.domain).toBe("");
    expect(input.password).toBe("");
    expect(input.dialect).toBe("");
    expect(input.marker).toBe("");
    expect(input.token).toBe("");
  });

  test("keeps a password exactly as given, including a leading space", () => {
    // The credentials file is written verbatim, so a password whose leading
    // space is real stays intact rather than silently becoming a wrong one.
    expect(
      readSmbProbeInput({ ...COMPLETE, SMB_PASS: " lead " }).password,
    ).toBe(" lead ");
  });

  test("names every missing required variable in one error", () => {
    let caught: unknown;
    try {
      readSmbProbeInput({ SMB_SHARE: "exchange" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain("SMB_SERVER is not set");
    expect((caught as Error).message).toContain("SMB_USER is not set");
  });
});

describe("values that would change what a command means are refused", () => {
  test("a path separator in the server or share, which re-points the connection", () => {
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_SERVER: "host/other" }),
    ).toThrow(UsageError);
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_SHARE: "exchange/sub" }),
    ).toThrow(UsageError);
  });

  test("a leading dash, which smbclient would read as an option", () => {
    expect(() => readSmbProbeInput({ ...COMPLETE, SMB_SERVER: "-L" })).toThrow(
      UsageError,
    );
  });

  test("a line break in a credential field, which would inject an auth-file line", () => {
    for (const name of ["SMB_USER", "SMB_DOMAIN", "SMB_PASS"])
      expect(() =>
        readSmbProbeInput({ ...COMPLETE, [name]: "a\npassword=other" }),
      ).toThrow(UsageError);
  });

  test("a marker or token that could end an smbclient command and begin another", () => {
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_MARKER: "m.txt; del *" }),
    ).toThrow(UsageError);
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_TOKEN: "t; del *" }),
    ).toThrow(UsageError);
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_MARKER: "../escape" }),
    ).toThrow(UsageError);
  });

  test("an unknown dialect, rather than passing it through to the client", () => {
    expect(() =>
      readSmbProbeInput({ ...COMPLETE, SMB_DIALECT: "SMB4" }),
    ).toThrow(UsageError);
  });

  test("a control character in the subdirectory", () => {
    expect(() =>
      readSmbProbeInput({
        ...COMPLETE,
        SMB_PATH: `drop${String.fromCharCode(7)}box`,
      }),
    ).toThrow(UsageError);
  });

  test("a semicolon in the subdirectory is fine: it travels as its own argument", () => {
    expect(
      readSmbProbeInput({ ...COMPLETE, SMB_PATH: "q3;final" }).subdirectory,
    ).toBe("q3;final");
  });
});

describe("the mount-side inputs", () => {
  test("read the marker and token, both optional", () => {
    expect(readSmbMountInput(COMPLETE)).toEqual({
      marker: "psilink-check.txt",
      token: "abc123",
    });
    expect(readSmbMountInput({})).toEqual({ marker: "", token: "" });
  });

  test("refuse a marker that is not a plain filename", () => {
    expect(() => readSmbMountInput({ SMB_MARKER: "../../etc/passwd" })).toThrow(
      UsageError,
    );
  });
});
