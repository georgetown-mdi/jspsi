import { describe, expect, test } from "vitest";

import {
  sftpEndpointForRemote,
  sftpRemoteOptionLabel,
} from "@bench/sftpRemoteChoice";

describe("sftpEndpointForRemote", () => {
  test("authors the endpoint from the remote's locator fields verbatim", () => {
    expect(
      sftpEndpointForRemote({
        name: "prod_east",
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
    const endpoint = sftpEndpointForRemote({
      name: "dr_west",
      host: "dr.example.gov",
    });
    expect(endpoint).toStrictEqual({ channel: "sftp", host: "dr.example.gov" });
    expect("port" in endpoint).toBe(false);
    expect("path" in endpoint).toBe(false);
  });

  test("the remote NAME never reaches the endpoint", () => {
    const endpoint = sftpEndpointForRemote({
      name: "prod_east",
      host: "sftp.example.gov",
    });
    expect(Object.values(endpoint)).not.toContain("prod_east");
    expect("name" in endpoint).toBe(false);
    expect("remote" in endpoint).toBe(false);
  });
});

describe("sftpRemoteOptionLabel", () => {
  test("names the remote and its full locator", () => {
    expect(
      sftpRemoteOptionLabel({
        name: "prod_east",
        host: "sftp.example.gov",
        port: 2222,
        path: "/exchanges",
      }),
    ).toBe("prod_east - sftp.example.gov:2222 /exchanges");
  });

  test("drops absent locator parts", () => {
    expect(
      sftpRemoteOptionLabel({ name: "dr_west", host: "dr.example.gov" }),
    ).toBe("dr_west - dr.example.gov");
  });
});
