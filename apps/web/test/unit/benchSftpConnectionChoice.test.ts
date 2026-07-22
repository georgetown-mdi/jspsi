import { describe, expect, test } from "vitest";

import {
  sftpBootServerMismatch,
  sftpConnectionLabel,
  sftpEndpointForConnection,
} from "@bench/sftpConnectionChoice";

describe("sftpEndpointForConnection", () => {
  test("authors the endpoint from the connection's locator fields verbatim", () => {
    expect(
      sftpEndpointForConnection({
        host: "sftp.example.gov",
        port: 2222,
        path: "/exchanges/psilink",
      }),
    ).toStrictEqual({
      channel: "sftp",
      host: "sftp.example.gov",
      port: 2222,
      path: "/exchanges/psilink",
    });
  });

  test("omits absent optional fields rather than sending empties", () => {
    // An omitted port/path must stay omitted: the strict endpoint schema at
    // mint rejects empty strings, and the CLI defaults an absent path.
    const endpoint = sftpEndpointForConnection({ host: "dr.example.gov" });
    expect(endpoint).toStrictEqual({ channel: "sftp", host: "dr.example.gov" });
    expect("port" in endpoint).toBe(false);
    expect("path" in endpoint).toBe(false);
  });

  test("no connection name concept reaches the endpoint", () => {
    const endpoint = sftpEndpointForConnection({ host: "sftp.example.gov" });
    expect("name" in endpoint).toBe(false);
    expect("remote" in endpoint).toBe(false);
  });
});

describe("sftpConnectionLabel", () => {
  test("names the full locator, no name prefix", () => {
    expect(
      sftpConnectionLabel({
        host: "sftp.example.gov",
        port: 2222,
        path: "/exchanges",
      }),
    ).toBe("sftp.example.gov:2222 /exchanges");
  });

  test("drops absent locator parts", () => {
    expect(sftpConnectionLabel({ host: "dr.example.gov" })).toBe(
      "dr.example.gov",
    );
  });
});

describe("sftpBootServerMismatch", () => {
  test("a different host is a mismatch", () => {
    expect(
      sftpBootServerMismatch(
        { host: "sftp.partner.example", port: 2022, path: "/drop" },
        { host: "boot.internal.example", port: 2022, path: "/drop" },
      ),
    ).toBe(true);
  });

  test("the same host (case-insensitive) with matching port and path does not warn", () => {
    expect(
      sftpBootServerMismatch(
        { host: "SFTP.Partner.Example", port: 2022, path: "/drop" },
        { host: "sftp.partner.example", port: 2022, path: "/drop" },
      ),
    ).toBe(false);
  });

  test("an omitted port matches the default 22 on either side", () => {
    expect(sftpBootServerMismatch({ host: "h", port: 22 }, { host: "h" })).toBe(
      false,
    );
    expect(sftpBootServerMismatch({ host: "h" }, { host: "h", port: 22 })).toBe(
      false,
    );
  });

  test("a different port or remote directory is a mismatch", () => {
    expect(
      sftpBootServerMismatch(
        { host: "h", port: 22 },
        { host: "h", port: 2222 },
      ),
    ).toBe(true);
    expect(
      sftpBootServerMismatch(
        { host: "h", path: "/a" },
        { host: "h", path: "/b" },
      ),
    ).toBe(true);
    expect(
      sftpBootServerMismatch({ host: "h", path: "/a" }, { host: "h" }),
    ).toBe(true);
  });
});
