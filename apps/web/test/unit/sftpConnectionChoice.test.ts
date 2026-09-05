import { describe, expect, test } from "vitest";

import {
  sftpConnectionLabel,
  sftpEndpointForConnection,
  splitDirectoryRetainProblem,
} from "@console/sftpConnectionChoice";
import { SPLIT_DIRECTORY_RETAIN_REQUIREMENT } from "@console/sftpConnectionForm";

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

  test("holds a split pair unmirrored, so the partner's own swap applies once", () => {
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
    // The pair is emitted only whole. A projection holding one half is a shape
    // the console cannot author, and the mint's own schema refuses a half pair.
    const endpoint = sftpEndpointForConnection({
      host: "sftp.example.gov",
      inboundPath: "/exchange/in",
    });
    expect("inboundPath" in endpoint).toBe(false);
    expect("outboundPath" in endpoint).toBe(false);
  });
});

describe("splitDirectoryRetainProblem", () => {
  const split = {
    host: "sftp.example.gov",
    inboundPath: "/exchange/in",
    outboundPath: "/exchange/out",
  };

  test("blocks a split connection once retain mode is turned back off", () => {
    // The state the authoring form cannot catch: the connection was authored
    // under retain mode, and the toggle on the other card was flipped after. The
    // block holds the form's own requirement, so both name the same control.
    const problem = splitDirectoryRetainProblem(split, false);
    expect(problem).toBe(SPLIT_DIRECTORY_RETAIN_REQUIREMENT);
    expect(problem).toContain("Keep every exchange file");
  });

  test("retain mode back on clears the block", () => {
    expect(splitDirectoryRetainProblem(split, true)).toBeUndefined();
  });

  test("a single-directory connection is unaffected by the toggle", () => {
    for (const retainFiles of [true, false]) {
      expect(
        splitDirectoryRetainProblem(
          { host: "sftp.example.gov", path: "/exchange" },
          retainFiles,
        ),
      ).toBeUndefined();
      expect(
        splitDirectoryRetainProblem({ host: "sftp.example.gov" }, retainFiles),
      ).toBeUndefined();
    }
  });

  test("no connection is no block, before the fetch resolves or with none set up", () => {
    expect(splitDirectoryRetainProblem(null, false)).toBeUndefined();
    expect(splitDirectoryRetainProblem(undefined, false)).toBeUndefined();
  });

  test("a half pair is not a split, the same shape the endpoint refuses to emit", () => {
    expect(
      splitDirectoryRetainProblem(
        { host: "sftp.example.gov", inboundPath: "/exchange/in" },
        false,
      ),
    ).toBeUndefined();
    expect(
      splitDirectoryRetainProblem(
        { host: "sftp.example.gov", outboundPath: "/exchange/out" },
        false,
      ),
    ).toBeUndefined();
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
