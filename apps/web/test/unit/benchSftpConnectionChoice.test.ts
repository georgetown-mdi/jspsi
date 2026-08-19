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

  test("carries a split pair unmirrored, so the partner's own swap applies once", () => {
    // An SFTPEndpoint's pair is defined from the INVITER's side, and the swap
    // that makes the acceptor read where the inviter writes belongs to whoever
    // builds a connection from the endpoint. Mirroring here would apply it twice.
    const endpoint = sftpEndpointForConnection({
      host: "sftp.example.gov",
      inboundPath: "/exchange/in",
      outboundPath: "/exchange/out",
    });
    expect(endpoint).toStrictEqual({
      channel: "sftp",
      host: "sftp.example.gov",
      inboundPath: "/exchange/in",
      outboundPath: "/exchange/out",
    });
    expect("path" in endpoint).toBe(false);
  });

  test("a half pair reaches the endpoint as neither half", () => {
    // The pair is emitted only whole. A projection carrying one half is a shape
    // the appliance cannot author, and the mint's own schema refuses a half pair.
    const endpoint = sftpEndpointForConnection({
      host: "sftp.example.gov",
      inboundPath: "/exchange/in",
    });
    expect("inboundPath" in endpoint).toBe(false);
    expect("outboundPath" in endpoint).toBe(false);
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

  test("names both halves of a split, in the direction they run", () => {
    expect(
      sftpConnectionLabel({
        host: "sftp.example.gov",
        inboundPath: "/exchange/in",
        outboundPath: "/exchange/out",
      }),
    ).toBe("sftp.example.gov in /exchange/in out /exchange/out");
  });
});
