import { describe, expect, test } from "vitest";

import {
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
